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

const sitemap =
  '<?xml version="1.0"?><urlset>' +
  "<url><loc>https://main--site--org.aem.live/</loc><lastmod>2026-01-01</lastmod></url>" +
  "<url><loc>https://main--site--org.aem.live/docs/faq</loc></url>" +
  "<url><loc>https://main--site--org.aem.live/docs/setup</loc></url>" +
  "<url><loc>https://main--site--org.aem.live/blog/post-1</loc><lastmod>2026-02-02</lastmod></url>" +
  "</urlset>";

const queryIndex = JSON.stringify({
  data: [{ path: "/docs/faq", title: "FAQ", description: "Answers" }],
});

function runKb(
  name: string,
  args: unknown,
  pages: (req: MockRequest) => MockResponse | undefined,
  headers: Record<string, string> = {},
): { output: string; first: MockRequest | undefined } {
  let output = "";
  let first: MockRequest | undefined;
  callWorker({
    headers: { authorization: "Bearer k", "x-org": "org", "x-repo": "site", ...headers },
    body: JSON.stringify({ input: "x" }),
    fetchMock: (req) => {
      if (req.url.includes("ai-gateway.vercel.sh")) {
        const parsed = JSON.parse(req.body);
        if (!first) first = req;
        const toolMsg = parsed.messages.find((m: any) => m.role === "tool");
        if (toolMsg) {
          output = toolMsg.content;
          return answer;
        }
        return toolTurn(name, args);
      }
      return pages(req) ?? { status: 599, body: "unexpected " + req.url };
    },
  });
  return { output, first };
}

describe("knowledgebase tools", () => {
  it("advertises the kb tools and manual only when bound", () => {
    const { first } = runKb("knowledgebase_list", {}, (req) => {
      if (req.url.endsWith("/sitemap.xml"))
        return { status: 200, contentType: "application/xml", body: sitemap };
      return { status: 404 };
    });
    const body = JSON.parse(first!.body);
    expect(body.tools.map((t: any) => t.function.name)).toEqual([
      "web_search",
      "web_fetch",
      "knowledgebase_list",
      "knowledgebase_get",
    ]);
    expect(body.messages[0].content).toContain("https://main--site--org.aem.live");
  });

  it("lists pages with prefix filter and query-index merge", () => {
    const { output } = runKb("knowledgebase_list", { prefix: "/docs" }, (req) => {
      if (req.url === "https://main--site--org.aem.live/sitemap.xml")
        return { status: 200, contentType: "application/xml", body: sitemap };
      if (req.url === "https://main--site--org.aem.live/query-index.json")
        return { status: 200, contentType: "application/json", body: queryIndex };
      return undefined;
    });
    expect(output).toContain("2 pages in org/site@main (https://main--site--org.aem.live)");
    expect(output).toContain("1. /docs/faq\n   FAQ\n   Answers");
    expect(output).toContain("2. /docs/setup");
    expect(output).not.toContain("/blog/post-1");
    expect(output).toContain("Read a page with knowledgebase_get using its path.");
  });

  it("fetches a page as markdown, falling back to index.md", () => {
    const { output } = runKb(
      "knowledgebase_get",
      { path: "https://dev--site--org.aem.live/docs/faq.md" },
      (req) => {
        if (req.url === "https://dev--site--org.aem.live/docs/faq.md") return { status: 404 };
        if (req.url === "https://dev--site--org.aem.live/docs/faq/index.md")
          return { status: 200, contentType: "text/markdown", url: req.url, body: "# The FAQ\n\nQ and A." };
        return undefined;
      },
      { "x-ref": "dev" },
    );
    expect(output).toContain("path: /docs/faq");
    expect(output).toContain("url: https://dev--site--org.aem.live/docs/faq/index.md");
    expect(output).toContain("title: The FAQ");
    expect(output).toContain("Q and A.");
  });

  it("refuses paths that escape the site", () => {
    const { output } = runKb("knowledgebase_get", { path: "/docs/../secret" }, () => undefined);
    expect(output).toBe("knowledgebase_get: refusing a path that escapes the site: /docs/../secret");
  });

  it("reports missing pages", () => {
    const { output } = runKb("knowledgebase_get", { path: "/nope" }, (req) =>
      req.url.endsWith(".md") ? { status: 404 } : undefined,
    );
    expect(output).toBe("knowledgebase_get: path not found: /nope");
  });
});
