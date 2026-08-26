import { describe, expect, it } from "vitest";
import { callWorker } from "./harness.js";
import type { MockRequest, MockResponse } from "./harness.js";

const answer: MockResponse = {
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: "done" } }] }),
};

const toolTurn = (name: string, args: unknown): MockResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    choices: [
      { message: { tool_calls: [{ id: "c1", function: { name, arguments: JSON.stringify(args) } }] } },
    ],
  }),
});

/** Runs one tool call through the agent and captures the tool output. */
function runTool(
  name: string,
  args: unknown,
  env: Record<string, string>,
  mock: (req: MockRequest) => MockResponse,
): { output: string; result: ReturnType<typeof callWorker> } {
  let output = "";
  const result = callWorker({
    headers: { authorization: "Bearer k" },
    env,
    body: JSON.stringify({ input: "x" }),
    fetchMock: (req) => {
      if (req.url.includes("ai-gateway.vercel.sh") || req.url.includes("gateway.test")) {
        const parsed = JSON.parse(req.body);
        if (parsed.tools?.[0]?.type?.startsWith?.("vercel:")) return mock(req);
        const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
        if (toolMsg) {
          output = toolMsg.content;
          return answer;
        }
        return toolTurn(name, args);
      }
      return mock(req);
    },
  });
  return { output, result };
}

describe("web_search providers", () => {
  it("brave: url, freshness mapping, key header, dedupe, cleanup", () => {
    let braveReq: MockRequest | undefined;
    const { output } = runTool(
      "web_search",
      { query: "zig", count: 2, freshness: "week" },
      { SEARCH_PROVIDER: "brave", SEARCH_API_KEY: "bk" },
      (req) => {
        braveReq = req;
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            web: {
              results: [
                { title: "A <b>Zig</b>", url: "https://a.example/", description: "first &amp; best" },
                { title: "B", url: "https://b.example/", description: "second" },
                { title: "dup", url: "https://a.example/", description: "dup" },
              ],
            },
          }),
        };
      },
    );
    expect(braveReq!.url).toBe("https://api.search.brave.com/res/v1/web/search?q=zig&count=2&freshness=pw");
    expect(braveReq!.headers["x-subscription-token"]).toBe("bk");
    expect(output).toContain("2 results for: zig");
    expect(output).toContain("A Zig");
    expect(output).toContain("first & best");
  });

  it("ddg: parses the html result list and follows uddg", () => {
    const { output } = runTool("web_search", { query: "zig" }, { SEARCH_PROVIDER: "ddg" }, () => ({
      status: 200,
      contentType: "text/html",
      body:
        '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fziglang.org%2F&rut=1">Zig &middot; Home</a>' +
        '<a class="result__snippet" href="#">A <b>general-purpose</b> language</a>' +
        '<a class="result__a" href="https://ziglang.org/learn/">Learn</a>',
    }));
    expect(output).toContain("2 results for: zig");
    expect(output).toContain("https://ziglang.org/");
    expect(output).toContain("Zig · Home");
    expect(output).toContain("A general-purpose language");
    expect(output).toContain("https://ziglang.org/learn/");
  });

  it("gateway search: server tool config and fenced JSON results", () => {
    let searchReq: MockRequest | undefined;
    const { output } = runTool(
      "web_search",
      { query: "zig news", site: "ziglang.org", freshness: "week" },
      { SEARCH_PROVIDER: "perplexity" },
      (req) => {
        searchReq = req;
        return {
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            choices: [
              {
                message: {
                  content: '```json\n{"results":[{"title":"T1","url":"https://t1.example/","snippet":"S1"}]}\n```',
                  provider_metadata: { gateway: { gatewayToolCalls: { perplexity_search: 1 } } },
                },
              },
            ],
          }),
        };
      },
    );
    const tools = JSON.parse(searchReq!.body).tools;
    expect(tools[0].type).toBe("vercel:perplexity_search");
    expect(tools[0].config).toEqual({
      query: "zig news",
      max_results: 6,
      search_domain_filter: ["ziglang.org"],
      search_recency_filter: "week",
    });
    expect(output).toContain("1 results for: zig news");
    expect(output).toContain("https://t1.example/");
  });

  it("keyed providers fail without SEARCH_API_KEY", () => {
    const { output, result } = runTool("web_search", { query: "zig" }, { SEARCH_PROVIDER: "exa" }, () => ({
      status: 599,
      body: "",
    }));
    expect(output).toBe("web_search: search provider 'exa' requires SEARCH_API_KEY to be configured on the proxy");
    expect((result.json as any).output[0].status).toBe("failed");
  });

  it("empty query fails cleanly", () => {
    const { output } = runTool("web_search", { query: "  " }, {}, () => ({ status: 599, body: "" }));
    expect(output).toBe("web_search: query must not be empty");
  });
});

describe("web_fetch", () => {
  it("extracts readable text, title and status", () => {
    const { output } = runTool("web_fetch", { url: "https://example.com/page" }, {}, (req) => ({
      status: 200,
      url: "https://example.com/page/",
      contentType: "text/html; charset=utf-8",
      body: "<html><head><title>My Page</title><style>x{}</style></head><body><h1>Hi</h1><p>Body &amp; soul</p></body></html>",
    }));
    expect(output).toContain("url: https://example.com/page/");
    expect(output).toContain("status: 200");
    expect(output).toContain("title: My Page");
    expect(output).toContain("Hi\nBody & soul");
  });

  it("refuses private hosts", () => {
    const { output } = runTool("web_fetch", { url: "https://169.254.169.254/latest" }, {}, () => ({
      status: 599,
      body: "",
    }));
    expect(output).toBe("web_fetch: refusing to fetch a private or loopback host: 169.254.169.254");
  });

  it("refuses non-http schemes", () => {
    const { output } = runTool("web_fetch", { url: "ftp://x.example/" }, {}, () => ({ status: 599, body: "" }));
    expect(output).toContain("web_fetch: unsupported URL scheme: ftp:");
  });

  it("refuses binary content types", () => {
    const { output } = runTool("web_fetch", { url: "https://example.com/a.pdf" }, {}, () => ({
      status: 200,
      contentType: "application/pdf",
      body: "%PDF",
    }));
    expect(output).toContain("unsupported content type for text extraction: application/pdf");
  });

  it("truncates long pages at max_chars", () => {
    const { output } = runTool(
      "web_fetch",
      { url: "https://example.com/big", max_chars: 500 },
      {},
      () => ({ status: 200, contentType: "text/plain", body: "y".repeat(2000) }),
    );
    expect(output).toContain("[truncated at 500 characters]");
  });
});

describe("unknown tools", () => {
  it("kb tools are rejected when no knowledge base is bound", () => {
    const { output } = runTool("knowledgebase_list", {}, {}, () => ({ status: 599, body: "" }));
    expect(output).toBe("unknown tool");
  });
});
