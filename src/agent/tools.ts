import type { FxHostTool } from "libfx/wasm";
import type { Config } from "../config.js";
import { fetchPage } from "../tools/fetchPage.js";
import {
  getPage,
  knowledgebaseOrigin,
  listPages,
  type Knowledgebase,
} from "../tools/knowledgebase.js";
import { ToolError, search } from "../tools/search.js";
import type { SearchResult } from "../tools/search.js";

/** Upper bound per tool result; fx copies at most 96 KiB back into the agent. */
const maxOutputChars = 24_000;
const defaultResultCount = 6;
const defaultFetchChars = 12_000;

export type ToolName = "web_search" | "web_fetch" | "knowledgebase_list" | "knowledgebase_get";

export interface ToolInvocation {
  id: string;
  tool: ToolName;
  /** Validated against the declared schema by fx before the handler runs. */
  arguments: Record<string, unknown>;
  query?: string;
  url?: string;
  path?: string;
}

export interface ToolCompletion extends ToolInvocation {
  isError: boolean;
  resultCount?: number;
  summary: string;
}

export interface ToolHooks {
  onStart?(invocation: ToolInvocation): void;
  onFinish?(completion: ToolCompletion): void;
}

export interface ToolOptions {
  config: Config;
  knowledgebase?: Knowledgebase;
  hooks?: ToolHooks;
}

interface HandlerResult {
  output: string;
  isError?: boolean;
  summary: string;
  resultCount?: number;
}

/**
 * The capabilities the model sees. A request that arrives without tools still
 * reaches the model as a request with web search, because these declarations are
 * handed to fx at startup and advertised on every model call.
 */
export function createHostTools(options: ToolOptions): FxHostTool[] {
  let counter = 0;
  const nextId = () => `call_${(counter += 1).toString().padStart(3, "0")}`;

  const track = async (
    tool: ToolName,
    args: Record<string, unknown>,
    describe: (args: Record<string, unknown>) => Pick<ToolInvocation, "query" | "url" | "path">,
    run: () => Promise<HandlerResult>,
  ): Promise<{ output: string; isError: boolean }> => {
    const invocation: ToolInvocation = { id: nextId(), tool, arguments: args, ...describe(args) };
    options.hooks?.onStart?.(invocation);
    let result: HandlerResult;
    try {
      result = await run();
    } catch (error) {
      result = { output: failureText(tool, error), isError: true, summary: describeError(error) };
    }
    options.hooks?.onFinish?.({
      ...invocation,
      isError: result.isError === true,
      resultCount: result.resultCount,
      summary: result.summary,
    });
    return { output: clamp(result.output), isError: result.isError === true };
  };

  const tools: FxHostTool[] = [
    {
      name: "web_search",
      description:
        "Search the public web and return ranked results with titles, URLs and snippets. " +
        "Use it for anything time-sensitive, factual or version-specific, and repeat it with " +
        "refined queries until the question is settled.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Search terms. Plain keywords work better than a question.",
            minLength: 1,
            maxLength: 400,
          },
          count: {
            type: "integer",
            description: `Maximum number of results (default ${defaultResultCount}).`,
            minimum: 1,
            maximum: 20,
          },
          site: {
            type: "string",
            description: "Restrict results to one domain, for example ziglang.org.",
            maxLength: 253,
          },
          freshness: {
            type: "string",
            description: "Limit results by age: past day, week, month or year.",
            enum: ["day", "week", "month", "year"],
          },
        },
        required: ["query"],
        additionalProperties: false,
      },
      handler: (args) =>
        track(
          "web_search",
          args,
          (value) => ({ query: typeof value.query === "string" ? value.query : undefined }),
          async () => {
            const query = String(args.query).trim();
            if (!query) {
              return { output: "web_search: query must not be empty", isError: true, summary: "empty query" };
            }
            const results = await search(
              {
                query,
                count: typeof args.count === "number" ? args.count : defaultResultCount,
                site: typeof args.site === "string" ? args.site : undefined,
                freshness: typeof args.freshness === "string" ? args.freshness : undefined,
              },
              options.config,
            );
            if (results.length === 0) {
              return { output: `no results for: ${query}`, summary: "no results", resultCount: 0 };
            }
            return {
              output: `${results.length} results for: ${query}\n\n${renderResults(results)}`,
              summary: `${results.length} results`,
              resultCount: results.length,
            };
          },
        ),
    },
    {
      name: "web_fetch",
      description:
        "Fetch one web page and return its readable text. Use it to read a promising search " +
        "result before relying on it. Only http and https URLs on public hosts are reachable.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "Absolute http or https URL.",
            maxLength: 2048,
          },
          max_chars: {
            type: "integer",
            description: `Maximum characters of page text to return (default ${defaultFetchChars}).`,
            minimum: 500,
            maximum: maxOutputChars - 500,
          },
        },
        required: ["url"],
        additionalProperties: false,
      },
      handler: (args) =>
        track(
          "web_fetch",
          args,
          (value) => ({ url: typeof value.url === "string" ? value.url : undefined }),
          async () => {
            const page = await fetchPage(
              String(args.url),
              typeof args.max_chars === "number" ? args.max_chars : defaultFetchChars,
            );
            const header = [
              `url: ${page.url}`,
              `status: ${page.status}`,
              page.title ? `title: ${page.title}` : undefined,
              "",
            ]
              .filter((line) => line !== undefined)
              .join("\n");
            return {
              output: `${header}${page.text}`,
              summary: `${page.status} ${page.contentType.split(";")[0] ?? ""}`.trim(),
            };
          },
        ),
    },
  ];

  const site = options.knowledgebase;
  if (!site) return tools;

  const origin = knowledgebaseOrigin(site);
  tools.push(
    {
      name: "knowledgebase_list",
      description:
        `List published pages in the bound AEM knowledge base (${site.org}/${site.repo}) ` +
        `from ${origin}/sitemap.xml. Use prefix to narrow to a folder such as /docs, then ` +
        "read a page with knowledgebase_get.",
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          prefix: {
            type: "string",
            description: "Only list paths under this prefix, for example /docs or /blog.",
            maxLength: 512,
          },
          query: {
            type: "string",
            description: "Optional substring filter applied to path, title and description.",
            maxLength: 200,
          },
          limit: {
            type: "integer",
            description: "Maximum number of pages to return (default 200).",
            minimum: 1,
            maximum: 500,
          },
        },
        additionalProperties: false,
      },
      handler: (args) =>
        track(
          "knowledgebase_list",
          args,
          (value) => ({
            query:
              typeof value.prefix === "string"
                ? value.prefix
                : typeof value.query === "string"
                  ? value.query
                  : undefined,
          }),
          async () => {
            const listed = await listPages(site, {
              prefix: typeof args.prefix === "string" ? args.prefix : undefined,
              query: typeof args.query === "string" ? args.query : undefined,
              limit: typeof args.limit === "number" ? args.limit : 200,
            });
            if (listed.pages.length === 0) {
              return {
                output: `no knowledge-base pages for ${listed.site}`,
                summary: "no results",
                resultCount: 0,
              };
            }
            const shown = listed.pages.length;
            const header =
              shown < listed.total
                ? `${shown} of ${listed.total} pages in ${listed.site} (${origin})`
                : `${listed.total} pages in ${listed.site} (${origin})`;
            return {
              output: `${header}\n\n${renderKnowledgebasePages(listed.pages)}\n\nRead a page with knowledgebase_get using its path.`,
              summary: `${shown} pages`,
              resultCount: shown,
            };
          },
        ),
    },
    {
      name: "knowledgebase_get",
      description:
        `Fetch one published page from the bound AEM knowledge base as markdown ` +
        `(${origin}/path.md). Pass a path from knowledgebase_list, not an arbitrary URL.`,
      readOnly: true,
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Site path such as /docs/faq, or a sitemap URL for that page.",
            minLength: 1,
            maxLength: 1024,
          },
          max_chars: {
            type: "integer",
            description: `Maximum characters of markdown to return (default ${defaultFetchChars}).`,
            minimum: 500,
            maximum: maxOutputChars - 500,
          },
        },
        required: ["path"],
        additionalProperties: false,
      },
      handler: (args) =>
        track(
          "knowledgebase_get",
          args,
          (value) => ({
            path: typeof value.path === "string" ? value.path : undefined,
            url: typeof value.path === "string" ? value.path : undefined,
          }),
          async () => {
            const page = await getPage(
              site,
              String(args.path),
              typeof args.max_chars === "number" ? args.max_chars : defaultFetchChars,
            );
            const header = [
              `path: ${page.path}`,
              `url: ${page.url}`,
              `status: ${page.status}`,
              page.title ? `title: ${page.title}` : undefined,
              "",
            ]
              .filter((line) => line !== undefined)
              .join("\n");
            return {
              output: `${header}${page.text}`,
              summary: `${page.status} ${page.path}`,
            };
          },
        ),
    },
  );
  return tools;
}

function renderKnowledgebasePages(pages: { path: string; lastmod?: string; title?: string; description?: string }[]): string {
  return pages
    .map((page, index) => {
      const lines = [`${index + 1}. ${page.path}`];
      if (page.title) lines.push(`   ${page.title}`);
      if (page.lastmod) lines.push(`   lastmod: ${page.lastmod}`);
      if (page.description) lines.push(`   ${page.description}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function renderResults(results: SearchResult[]): string {
  return results
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title || result.url}`, `   ${result.url}`];
      if (result.snippet) lines.push(`   ${result.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function failureText(tool: ToolName, error: unknown): string {
  if (error instanceof ToolError) return `${tool}: ${error.message}`;
  if (error instanceof Error && error.name === "AbortError") return `${tool}: aborted`;
  if (error instanceof Error && error.name === "TimeoutError") return `${tool}: timed out`;
  return `${tool}: ${describeError(error)}`;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clamp(value: string): string {
  return value.length <= maxOutputChars
    ? value
    : `${value.slice(0, maxOutputChars)}\n[output truncated]`;
}
