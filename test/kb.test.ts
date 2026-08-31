import { describe, expect, it } from "vitest";
import { callTool, TOOL } from "./harness.js";
import type { MockRequest, MockResponse } from "./harness.js";

const kbHeaders = { "x-org": "org", "x-repo": "site" };

const sitemap =
  '<?xml version="1.0"?><urlset>' +
  "<url><loc>https://main--site--org.aem.live/</loc><lastmod>2026-01-01</lastmod></url>" +
  "<url><loc>https://main--site--org.aem.live/docs/faq</loc></url>" +
  "<url><loc>https://main--site--org.aem.live/docs/setup</loc></url>" +
  "<url><loc>https://main--site--org.aem.live/blog/post-1</loc><lastmod>2026-02-02</lastmod></url>" +
  "</urlset>";

const queryIndex = JSON.stringify({ data: [{ path: "/docs/faq", title: "FAQ", description: "Answers" }] });

function pages(map: (req: MockRequest) => MockResponse | undefined) {
  return (req: MockRequest): MockResponse => map(req) ?? { status: 404 };
}

describe("knowledgebase tools", () => {
  it("lists pages with prefix filter and query-index merge", async () => {
    const r = await callTool(TOOL.knowledgebase_list, { prefix: "/docs" }, {
      headers: kbHeaders,
      fetchMock: pages((req) => {
        if (req.url === "https://main--site--org.aem.live/sitemap.xml")
          return { status: 200, contentType: "application/xml", body: sitemap };
        if (req.url === "https://main--site--org.aem.live/query-index.json")
          return { status: 200, contentType: "application/json", body: queryIndex };
        return undefined;
      }),
    });
    expect(r.output).toContain("2 pages in org/site@main (https://main--site--org.aem.live)");
    expect(r.output).toContain("1. /docs/faq\n   FAQ\n   Answers");
    expect(r.output).toContain("2. /docs/setup");
    expect(r.output).not.toContain("/blog/post-1");
    expect(r.output).toContain("Read a page with knowledgebase_get using its path.");
  });

  it("fetches a page as markdown, falling back to index.md", async () => {
    const r = await callTool(
      TOOL.knowledgebase_get,
      { path: "https://dev--site--org.aem.live/docs/faq.md" },
      {
        headers: { ...kbHeaders, "x-ref": "dev" },
        fetchMock: pages((req) => {
          if (req.url === "https://dev--site--org.aem.live/docs/faq.md") return { status: 404 };
          if (req.url === "https://dev--site--org.aem.live/docs/faq/index.md")
            return { status: 200, contentType: "text/markdown", url: req.url, body: "# The FAQ\n\nQ and A." };
          return undefined;
        }),
      },
    );
    expect(r.output).toContain("path: /docs/faq");
    expect(r.output).toContain("url: https://dev--site--org.aem.live/docs/faq/index.md");
    expect(r.output).toContain("title: The FAQ");
    expect(r.output).toContain("Q and A.");
  });

  it("refuses paths that escape the site", async () => {
    const r = await callTool(TOOL.knowledgebase_get, { path: "/docs/../secret" }, {
      headers: kbHeaders,
      fetchMock: () => ({ status: 404 }),
    });
    expect(r.output).toBe("knowledgebase_get: refusing a path that escapes the site: /docs/../secret");
  });

  it("reports missing pages", async () => {
    const r = await callTool(TOOL.knowledgebase_get, { path: "/nope" }, {
      headers: kbHeaders,
      fetchMock: () => ({ status: 404 }),
    });
    expect(r.output).toBe("knowledgebase_get: path not found: /nope");
  });
});
