import { describe, expect, it } from "vitest";
import { callTool, TOOL } from "./harness.js";
import type { MockRequest, MockResponse } from "./harness.js";

describe("web_search providers", () => {
  it("brave: url, freshness mapping, key header, dedupe, cleanup", async () => {
    let braveReq: MockRequest | undefined;
    const r = await callTool(
      TOOL.web_search,
      { query: "zig", count: 2, freshness: "week" },
      {
        env: { SEARCH_PROVIDER: "brave", SEARCH_API_KEY: "bk" },
        fetchMock: (req) => {
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
      },
    );
    expect(braveReq!.url).toBe("https://api.search.brave.com/res/v1/web/search?q=zig&count=2&freshness=pw");
    expect(braveReq!.headers["x-subscription-token"]).toBe("bk");
    expect(r.output).toContain("2 results for: zig");
    expect(r.output).toContain("A Zig");
    expect(r.output).toContain("first & best");
  });

  it("ddg: parses the html result list and follows uddg", async () => {
    const r = await callTool(TOOL.web_search, { query: "zig" }, {
      env: { SEARCH_PROVIDER: "ddg" },
      fetchMock: () => ({
        status: 200,
        contentType: "text/html",
        body:
          '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fziglang.org%2F&rut=1">Zig &middot; Home</a>' +
          '<a class="result__snippet" href="#">A <b>general-purpose</b> language</a>' +
          '<a class="result__a" href="https://ziglang.org/learn/">Learn</a>',
      }),
    });
    expect(r.output).toContain("2 results for: zig");
    expect(r.output).toContain("https://ziglang.org/");
    expect(r.output).toContain("Zig · Home");
    expect(r.output).toContain("A general-purpose language");
  });

  it("gateway search: server tool config and fenced JSON results", async () => {
    let searchReq: MockRequest | undefined;
    const r = await callTool(
      TOOL.web_search,
      { query: "zig news", site: "ziglang.org", freshness: "week" },
      {
        headers: { authorization: "Bearer gwkey" },
        env: { SEARCH_PROVIDER: "perplexity" },
        fetchMock: (req) => {
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
    expect(r.output).toContain("1 results for: zig news");
    expect(r.output).toContain("https://t1.example/");
  });

  it("keyed providers fail without SEARCH_API_KEY", async () => {
    const r = await callTool(TOOL.web_search, { query: "zig" }, {
      env: { SEARCH_PROVIDER: "exa" },
      fetchMock: () => ({ status: 599, body: "" }),
    });
    expect(r.isError).toBe(true);
    expect(r.output).toBe("web_search: search provider 'exa' requires SEARCH_API_KEY to be configured on the proxy");
  });

  it("empty query fails cleanly", async () => {
    const r = await callTool(TOOL.web_search, { query: "  " }, { fetchMock: () => ({ status: 599, body: "" }) });
    expect(r.output).toBe("web_search: query must not be empty");
  });
});

describe("web_fetch", () => {
  const fetchMock = (res: MockResponse) => () => res;

  it("extracts readable text, title and status", async () => {
    const r = await callTool(TOOL.web_fetch, { url: "https://example.com/page" }, {
      fetchMock: fetchMock({
        status: 200,
        url: "https://example.com/page/",
        contentType: "text/html; charset=utf-8",
        body: "<html><head><title>My Page</title><style>x{}</style></head><body><h1>Hi</h1><p>Body &amp; soul</p></body></html>",
      }),
    });
    expect(r.output).toContain("url: https://example.com/page/");
    expect(r.output).toContain("status: 200");
    expect(r.output).toContain("title: My Page");
    expect(r.output).toContain("Hi\nBody & soul");
  });

  it("refuses private hosts", async () => {
    const r = await callTool(TOOL.web_fetch, { url: "https://169.254.169.254/latest" }, {
      fetchMock: fetchMock({ status: 599, body: "" }),
    });
    expect(r.output).toBe("web_fetch: refusing to fetch a private or loopback host: 169.254.169.254");
  });

  it("refuses non-http schemes", async () => {
    const r = await callTool(TOOL.web_fetch, { url: "ftp://x.example/" }, { fetchMock: fetchMock({ status: 599, body: "" }) });
    expect(r.output).toContain("web_fetch: unsupported URL scheme: ftp:");
  });

  it("refuses binary content types", async () => {
    const r = await callTool(TOOL.web_fetch, { url: "https://example.com/a.pdf" }, {
      fetchMock: fetchMock({ status: 200, contentType: "application/pdf", body: "%PDF" }),
    });
    expect(r.output).toContain("unsupported content type for text extraction: application/pdf");
  });

  it("truncates long pages at max_chars", async () => {
    const r = await callTool(TOOL.web_fetch, { url: "https://example.com/big", max_chars: 500 }, {
      fetchMock: fetchMock({ status: 200, contentType: "text/plain", body: "y".repeat(2000) }),
    });
    expect(r.output).toContain("[truncated at 500 characters]");
  });
});
