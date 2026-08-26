import type { Config, SearchProviderName } from "../config.js";
import { isGatewaySearchProvider } from "../config.js";
import { collapseBlankLines, decodeEntities, stripTags } from "../util/text.js";

export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface SearchQuery {
  query: string;
  count: number;
  site?: string;
  freshness?: string;
}

export class ToolError extends Error {}

const userAgent =
  "Mozilla/5.0 (compatible; fx-proxy/0.1; +https://github.com/ai-ecoverse/fx-proxy)";

export async function search(query: SearchQuery, config: Config): Promise<SearchResult[]> {
  const providerName = config.search.provider;
  const expanded: SearchQuery = isGatewaySearchProvider(providerName)
    ? query
    : {
        ...query,
        query: query.site ? `${query.query} site:${query.site}` : query.query,
      };
  const provider = providers[providerName];
  const results = await provider(expanded, config);
  return dedupe(results).slice(0, expanded.count);
}

type Provider = (query: SearchQuery, config: Config) => Promise<SearchResult[]>;

function requireKey(config: Config, provider: SearchProviderName): string {
  if (!config.search.apiKey) {
    throw new ToolError(
      `search provider '${provider}' requires SEARCH_API_KEY to be configured on the proxy`,
    );
  }
  return config.search.apiKey;
}

async function readJson(response: Response, provider: string): Promise<unknown> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new ToolError(
      `${provider} search failed with HTTP ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`,
    );
  }
  return response.json();
}

type GatewaySearchTool = "perplexity" | "parallel" | "tako";

/** Cheap formatter; the actual retrieval is the gateway server tool. */
const gatewaySearchModel = "alibaba/qwen3.7-flash";

/**
 * Runs a Vercel AI Gateway server search tool via chat completions.
 * The gateway executes the search internally and does not return raw hits,
 * so a short JSON-only follow-up extracts titles, URLs and snippets.
 */
async function gatewayServerSearch(
  query: SearchQuery,
  config: Config,
  tool: GatewaySearchTool,
): Promise<SearchResult[]> {
  if (!config.gatewayApiKey) {
    throw new ToolError(
      `search provider '${tool}' bills through Vercel AI Gateway; send an AI Gateway key as \`Authorization: Bearer <key>\``,
    );
  }

  const toolType = `vercel:${tool}_search`;
  const toolConfig = gatewayToolConfig(tool, query);
  const payload = (await readJson(
    await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.gatewayApiKey}`,
      },
      body: JSON.stringify({
        model: gatewaySearchModel,
        messages: [
          {
            role: "system",
            content:
              'Reply with JSON only of the form {"results":[{"title":"","url":"","snippet":""}]}. ' +
              "One-sentence snippets. Include every search hit. No markdown fences.",
          },
          { role: "user", content: query.query },
        ],
        tools: [{ type: toolType, config: toolConfig }],
        tool_choice: "required",
        max_tokens: 1200,
      }),
    }),
    tool,
  )) as {
    choices?: {
      message?: {
        content?: string;
        provider_metadata?: { gateway?: { gatewayToolCalls?: Record<string, number> } };
      };
    }[];
  };

  const message = payload.choices?.[0]?.message;
  const executed = message?.provider_metadata?.gateway?.gatewayToolCalls?.[`${tool}_search`] ?? 0;
  if (executed < 1) {
    throw new ToolError(`${tool} search was not executed by the AI Gateway`);
  }
  return parseGatewayResults(message?.content ?? "");
}

function gatewayToolConfig(tool: GatewaySearchTool, query: SearchQuery): Record<string, unknown> {
  if (tool === "parallel") {
    return {
      objective: query.query,
      max_results: query.count,
      ...(query.site ? { source_policy: { include_domains: [query.site] } } : {}),
    };
  }
  return {
    query: query.query,
    max_results: query.count,
    ...(query.site ? { search_domain_filter: [query.site] } : {}),
    ...(tool === "perplexity" && query.freshness ? { search_recency_filter: query.freshness } : {}),
  };
}

/** Exported for tests: turns the formatter model's JSON into search hits. */
export function parseGatewayResults(content: string): SearchResult[] {
  const trimmed = content.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const raw = (fenced ?? trimmed).trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ToolError("AI Gateway search returned unparseable results");
  }
  const rows = Array.isArray(parsed)
    ? parsed
    : ((parsed as { results?: unknown }).results ?? []);
  if (!Array.isArray(rows)) {
    throw new ToolError("AI Gateway search returned no result list");
  }
  return rows
    .map((row) => {
      const record = row as { title?: string; url?: string; snippet?: string };
      return {
        title: clean(record.title),
        url: typeof record.url === "string" ? record.url : "",
        snippet: clean(record.snippet),
      };
    })
    .filter((result) => result.url);
}

const providers: Record<SearchProviderName, Provider> = {
  async ddg(query) {
    // Keyless fallback. DuckDuckGo's HTML endpoint has no stability guarantees.
    const response = await fetch("https://html.duckduckgo.com/html/", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "user-agent": userAgent,
        accept: "text/html",
      },
      body: new URLSearchParams({ q: query.query, kl: "wt-wt" }).toString(),
    });
    if (!response.ok) {
      throw new ToolError(`duckduckgo search failed with HTTP ${response.status}`);
    }
    return parseDuckDuckGo(await response.text());
  },

  async brave(query, config) {
    const url = new URL("https://api.search.brave.com/res/v1/web/search");
    url.searchParams.set("q", query.query);
    url.searchParams.set("count", String(query.count));
    if (query.freshness) url.searchParams.set("freshness", braveFreshness(query.freshness));
    const payload = (await readJson(
      await fetch(url, {
        headers: {
          accept: "application/json",
          "x-subscription-token": requireKey(config, "brave"),
        },
      }),
      "brave",
    )) as { web?: { results?: { title?: string; url?: string; description?: string }[] } };
    return (payload.web?.results ?? []).map((result) => ({
      title: clean(result.title),
      url: result.url ?? "",
      snippet: clean(result.description),
    }));
  },

  async tavily(query, config) {
    const payload = (await readJson(
      await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${requireKey(config, "tavily")}`,
        },
        body: JSON.stringify({
          query: query.query,
          max_results: query.count,
          search_depth: "basic",
        }),
      }),
      "tavily",
    )) as { results?: { title?: string; url?: string; content?: string }[] };
    return (payload.results ?? []).map((result) => ({
      title: clean(result.title),
      url: result.url ?? "",
      snippet: clean(result.content),
    }));
  },

  async exa(query, config) {
    const payload = (await readJson(
      await fetch("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": requireKey(config, "exa"),
        },
        body: JSON.stringify({
          query: query.query,
          numResults: query.count,
          contents: { text: { maxCharacters: 600 } },
        }),
      }),
      "exa",
    )) as { results?: { title?: string; url?: string; text?: string }[] };
    return (payload.results ?? []).map((result) => ({
      title: clean(result.title),
      url: result.url ?? "",
      snippet: clean(result.text),
    }));
  },

  async perplexity(query, config) {
    return gatewayServerSearch(query, config, "perplexity");
  },

  async parallel(query, config) {
    return gatewayServerSearch(query, config, "parallel");
  },

  async tako(query, config) {
    return gatewayServerSearch(query, config, "tako");
  },

  async serper(query, config) {
    const payload = (await readJson(
      await fetch("https://google.serper.dev/search", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": requireKey(config, "serper"),
        },
        body: JSON.stringify({ q: query.query, num: query.count }),
      }),
      "serper",
    )) as { organic?: { title?: string; link?: string; snippet?: string }[] };
    return (payload.organic ?? []).map((result) => ({
      title: clean(result.title),
      url: result.link ?? "",
      snippet: clean(result.snippet),
    }));
  },
};

/** Brave's freshness query param uses pd/pw/pm/py rather than day/week/month/year. */
function braveFreshness(value: string): string {
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
      return value;
  }
}

function clean(value: string | undefined): string {
  return value ? collapseBlankLines(decodeEntities(stripTags(value))) : "";
}

function dedupe(results: SearchResult[]): SearchResult[] {
  const seen = new Set<string>();
  const unique: SearchResult[] = [];
  for (const result of results) {
    if (!result.url || seen.has(result.url)) continue;
    seen.add(result.url);
    unique.push(result);
  }
  return unique;
}

/** Exported for tests: parses the DuckDuckGo HTML result list. */
export function parseDuckDuckGo(html: string): SearchResult[] {
  const results: SearchResult[] = [];
  const blockPattern =
    /<a[^>]+class="[^"]*result__a[^"]*"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]{0,2000}?)(?=<a[^>]+class="[^"]*result__a|<\/div>\s*<\/div>\s*<\/div>|$)/g;

  for (const match of html.matchAll(blockPattern)) {
    const href = match[1] ?? "";
    const url = resolveDuckDuckGoUrl(href);
    if (!url) continue;
    const snippet = match[3]?.match(
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/,
    )?.[1];
    results.push({
      title: clean(match[2]),
      url,
      snippet: clean(snippet),
    });
  }
  return results;
}

function resolveDuckDuckGoUrl(href: string): string | undefined {
  const decoded = decodeEntities(href);
  const absolute = decoded.startsWith("//") ? `https:${decoded}` : decoded;
  let parsed: URL;
  try {
    parsed = new URL(absolute, "https://duckduckgo.com");
  } catch {
    return undefined;
  }
  const redirected = parsed.searchParams.get("uddg");
  if (redirected) {
    try {
      return new URL(redirected).toString();
    } catch {
      return undefined;
    }
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : undefined;
}
