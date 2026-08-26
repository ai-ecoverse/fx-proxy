import { afterEach, describe, expect, it, vi } from "vitest";
import { parseDuckDuckGo, parseGatewayResults, search } from "../src/tools/search.js";
import { assertFetchableUrl } from "../src/tools/fetchPage.js";
import { htmlToText } from "../src/util/text.js";
import type { Config } from "../src/config.js";

const sample = `
<div class="results">
  <div class="result results_links">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffx.sh%2Fdocs&amp;rut=x">fx &mdash; docs</a>
    </h2>
    <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Ffx.sh%2Fdocs">Tiny, open, <b>native</b> coding agent.</a>
  </div>
  <div class="result results_links">
    <h2 class="result__title">
      <a rel="nofollow" class="result__a" href="https://github.com/vercel-labs/fx">vercel-labs/fx</a>
    </h2>
    <a class="result__snippet" href="https://github.com/vercel-labs/fx">Unix like coding agent</a>
  </div>
</div>`;

describe("parseDuckDuckGo", () => {
  it("extracts titles, unwrapped urls and snippets", () => {
    const results = parseDuckDuckGo(sample);
    expect(results).toHaveLength(2);
    expect(results[0]).toEqual({
      title: "fx — docs",
      url: "https://fx.sh/docs",
      snippet: "Tiny, open, native coding agent.",
    });
    expect(results[1]?.url).toBe("https://github.com/vercel-labs/fx");
  });

  it("returns nothing for an unrelated page", () => {
    expect(parseDuckDuckGo("<html><body>nope</body></html>")).toEqual([]);
  });
});

describe("assertFetchableUrl", () => {
  it("accepts public https urls", () => {
    expect(assertFetchableUrl("https://fx.sh/docs").hostname).toBe("fx.sh");
  });

  it("rejects private and non-http targets", () => {
    expect(() => assertFetchableUrl("http://localhost:8080")).toThrow(/loopback/);
    expect(() => assertFetchableUrl("http://192.168.1.1/")).toThrow(/private/);
    expect(() => assertFetchableUrl("file:///etc/passwd")).toThrow(/scheme/);
    expect(() => assertFetchableUrl("notaurl")).toThrow(/valid absolute URL/);
  });
});

describe("htmlToText", () => {
  it("drops scripts and keeps block structure", () => {
    const text = htmlToText(
      "<html><head><style>a{}</style></head><body><h1>Title</h1><script>evil()</script><p>One</p><p>Two</p></body></html>",
    );
    expect(text).toBe("Title\nOne\nTwo");
  });
});

describe("parseGatewayResults", () => {
  it("accepts a JSON object or a fenced block", () => {
    expect(
      parseGatewayResults('{"results":[{"title":"Zig","url":"https://ziglang.org","snippet":"lang"}]}'),
    ).toEqual([{ title: "Zig", url: "https://ziglang.org", snippet: "lang" }]);
    expect(
      parseGatewayResults('```json\n{"results":[{"title":"Zig","url":"https://ziglang.org","snippet":"lang"}]}\n```'),
    ).toHaveLength(1);
  });
});

describe("gateway perplexity search", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls vercel:perplexity_search with the gateway key", async () => {
    const fetchSpy = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        tools: { type: string; config: { query: string; search_domain_filter?: string[] } }[];
      };
      expect(body.tools[0]?.type).toBe("vercel:perplexity_search");
      expect(body.tools[0]?.config.query).toBe("zig 0.16");
      expect(body.tools[0]?.config.search_domain_filter).toEqual(["ziglang.org"]);
      return new Response(
        JSON.stringify({
          choices: [
            {
              message: {
                content: JSON.stringify({
                  results: [
                    {
                      title: "Release notes",
                      url: "https://ziglang.org/download/0.16.0/release-notes.html",
                      snippet: "Zig 0.16.0",
                    },
                  ],
                }),
                provider_metadata: { gateway: { gatewayToolCalls: { perplexity_search: 1 } } },
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    vi.stubGlobal("fetch", fetchSpy);

    const config: Config = {
      defaultModel: "alibaba/qwen3.7-flash",
      maxAgentSteps: 8,
      gatewayApiKey: "vck_test",
      search: { provider: "perplexity" },
    };
    const results = await search({ query: "zig 0.16", count: 5, site: "ziglang.org" }, config);
    expect(results).toEqual([
      {
        title: "Release notes",
        url: "https://ziglang.org/download/0.16.0/release-notes.html",
        snippet: "Zig 0.16.0",
      },
    ]);
    const headers = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer vck_test");
  });

  it("rejects a formatter response that never invoked the server tool", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"results":[{"title":"nope","url":"https://example.com","snippet":"x"}]}',
                  provider_metadata: { gateway: { gatewayToolCalls: {} } },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      ),
    );
    const config: Config = {
      defaultModel: "alibaba/qwen3.7-flash",
      maxAgentSteps: 8,
      gatewayApiKey: "vck_test",
      search: { provider: "perplexity" },
    };
    await expect(search({ query: "zig", count: 3 }, config)).rejects.toThrow(/not executed/);
  });
});

describe.skipIf(!process.env.LIVE_GATEWAY_KEY)("live Vercel AI Gateway search", () => {
  it("returns ziglang.org hits through perplexity", async () => {
    const results = await search(
      { query: "Zig 0.16 release notes", count: 5, site: "ziglang.org" },
      {
        defaultModel: "alibaba/qwen3.7-flash",
        maxAgentSteps: 8,
        gatewayApiKey: process.env.LIVE_GATEWAY_KEY,
        search: { provider: "perplexity" },
      },
    );
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.url.includes("ziglang.org"))).toBe(true);
  }, 60_000);
});
