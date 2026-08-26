import type { FxHostTool } from "libfx/wasm";
import type { Config } from "../config.js";
import { fetchPage } from "../tools/fetchPage.js";
import { ToolError, search } from "../tools/search.js";
import type { SearchResult } from "../tools/search.js";

/** Upper bound per tool result; fx copies at most 96 KiB back into the agent. */
const maxOutputChars = 24_000;
const defaultResultCount = 6;
const defaultFetchChars = 12_000;

export type ToolName = "web_search" | "web_fetch";

export interface ToolInvocation {
  id: string;
  tool: ToolName;
  /** Validated against the declared schema by fx before the handler runs. */
  arguments: Record<string, unknown>;
  query?: string;
  url?: string;
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
    describe: (args: Record<string, unknown>) => Pick<ToolInvocation, "query" | "url">,
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

  return [
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
                freshness: freshnessCode(args.freshness),
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
}

/** Providers expect their own freshness codes; the schema exposes plain words. */
function freshnessCode(value: unknown): string | undefined {
  switch (value) {
    case "day":
      return "pd";
    case "week":
      return "pw";
    case "month":
      return "pm";
    case "year":
      return "py";
    default:
      return undefined;
  }
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
