import { afterEach, describe, expect, it, vi } from "vitest";
import {
  canonicalPath,
  getPage,
  knowledgebaseOrigin,
  listPages,
  markdownCandidates,
  parseKnowledgebaseHeaders,
  parseSitemap,
} from "../src/tools/knowledgebase.js";
import { createHostTools } from "../src/agent/tools.js";
import type { Config } from "../src/config.js";

const site = { org: "adobe", repo: "aem-website", ref: "main" };
const origin = "https://main--aem-website--adobe.aem.live";

const sitemap = `<?xml version="1.0" encoding="utf-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>https://www.aem.live/docs/faq</loc>
    <lastmod>2026-08-05</lastmod>
  </url>
  <url>
    <loc>https://www.aem.live/docs/</loc>
    <lastmod>2026-07-30</lastmod>
  </url>
  <url>
    <loc>https://www.aem.live/developer/block-collection</loc>
  </url>
  <url>
    <loc>https://www.aem.live/blog</loc>
  </url>
</urlset>`;

const queryIndex = {
  data: [
    { path: "/docs/faq", title: "FAQ", description: "Frequently asked questions" },
    { path: "/docs/", title: "Documentation" },
  ],
};

const config: Config = {
  defaultModel: "alibaba/qwen3.7-flash",
  maxAgentSteps: 8,
  search: { provider: "ddg" },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("parseKnowledgebaseHeaders", () => {
  it("binds adobe/aem-website from x-org and x-repo", () => {
    const headers = new Headers({ "x-org": "adobe", "x-repo": "aem-website" });
    expect(parseKnowledgebaseHeaders(headers)).toEqual(site);
    expect(knowledgebaseOrigin(site)).toBe(origin);
  });

  it("accepts owner/site aliases and an explicit ref", () => {
    const headers = new Headers({
      "x-owner": "adobe",
      "x-site": "aem-website",
      "x-ref": "stage",
    });
    expect(parseKnowledgebaseHeaders(headers)).toEqual({
      org: "adobe",
      repo: "aem-website",
      ref: "stage",
    });
  });

  it("is absent unless both org and repo are set", () => {
    expect(parseKnowledgebaseHeaders(new Headers({ "x-org": "adobe" }))).toBeUndefined();
    expect(parseKnowledgebaseHeaders(new Headers())).toBeUndefined();
  });

  it("rejects a name that would break the aem.live host", () => {
    const headers = new Headers({ "x-org": "adobe", "x-repo": "aem--website" });
    expect(() => parseKnowledgebaseHeaders(headers)).toThrow(/invalid repo/);
  });
});

describe("canonicalPath", () => {
  it("normalizes sitemap URLs, .md suffixes and trailing slashes", () => {
    expect(canonicalPath("https://www.aem.live/docs/faq")).toBe("/docs/faq");
    expect(canonicalPath("/docs/faq.md")).toBe("/docs/faq");
    expect(canonicalPath("docs/faq/")).toBe("/docs/faq");
    expect(canonicalPath("/")).toBe("/");
  });

  it("refuses path traversal", () => {
    expect(() => canonicalPath("/docs/../../etc/passwd")).toThrow(/escapes/);
  });
});

describe("markdownCandidates", () => {
  it("maps the homepage and folders onto AEM markdown URLs", () => {
    expect(markdownCandidates("/")).toEqual(["/index.md"]);
    expect(markdownCandidates("/docs")).toEqual(["/docs.md", "/docs/index.md"]);
    expect(markdownCandidates("/developer/block-collection")).toEqual([
      "/developer/block-collection.md",
      "/developer/block-collection/index.md",
    ]);
  });
});

describe("parseSitemap", () => {
  it("extracts paths and lastmod from a urlset", () => {
    const { pages, sitemaps } = parseSitemap(sitemap, origin);
    expect(sitemaps).toEqual([]);
    expect(pages.map((page) => page.path)).toEqual([
      "/docs/faq",
      "/docs",
      "/developer/block-collection",
      "/blog",
    ]);
    expect(pages[0]?.lastmod).toBe("2026-08-05");
  });

  it("follows a sitemap index", () => {
    const index = `<?xml version="1.0"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <sitemap><loc>${origin}/sitemap-en.xml</loc></sitemap>
</sitemapindex>`;
    const { pages, sitemaps } = parseSitemap(index, origin);
    expect(pages).toEqual([]);
    expect(sitemaps).toEqual([`${origin}/sitemap-en.xml`]);
  });
});

describe("listPages", () => {
  it("filters by prefix and attaches query-index titles", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url.endsWith("/sitemap.xml")) return new Response(sitemap, { status: 200 });
        if (url.endsWith("/query-index.json")) {
          return new Response(JSON.stringify(queryIndex), { status: 200 });
        }
        return new Response("nope", { status: 404 });
      }),
    );

    const listed = await listPages(site, { prefix: "/docs", limit: 50 });
    expect(listed.origin).toBe(origin);
    expect(listed.pages.map((page) => page.path)).toEqual(["/docs/faq", "/docs"]);
    expect(listed.pages[0]).toMatchObject({ title: "FAQ", description: "Frequently asked questions" });
    expect(listed.total).toBe(2);
  });
});

describe("getPage", () => {
  it("fetches the .md representation and falls back to index.md", async () => {
    const fetchSpy = vi.fn(async (input: RequestInfo) => {
      const url = String(input);
      if (url.endsWith("/docs.md")) {
        return new Response("<html>hub</html>", {
          status: 200,
          headers: { "content-type": "text/html" },
        });
      }
      if (url.endsWith("/docs/index.md")) {
        return new Response("# Documentation\n\nHub for authors.", {
          status: 200,
          headers: { "content-type": "text/markdown; charset=utf-8" },
        });
      }
      return new Response("missing", { status: 404 });
    });
    vi.stubGlobal("fetch", fetchSpy);

    const page = await getPage(site, "/docs/", 12_000);
    expect(page.path).toBe("/docs");
    expect(page.title).toBe("Documentation");
    expect(page.text).toContain("Hub for authors.");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("knowledgebase host tools", () => {
  it("are omitted unless a site is bound", () => {
    expect(createHostTools({ config }).map((tool) => tool.name)).toEqual(["web_search", "web_fetch"]);
    expect(
      createHostTools({ config, knowledgebase: site }).map((tool) => tool.name),
    ).toEqual(["web_search", "web_fetch", "knowledgebase_list", "knowledgebase_get"]);
  });

  it("lists and reads through the bound origin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo) => {
        const url = String(input);
        if (url === `${origin}/sitemap.xml`) return new Response(sitemap, { status: 200 });
        if (url === `${origin}/query-index.json`) {
          return new Response(JSON.stringify(queryIndex), { status: 200 });
        }
        if (url === `${origin}/docs/faq.md`) {
          return new Response("# FAQ\n\nAnswers.", {
            status: 200,
            headers: { "content-type": "text/markdown" },
          });
        }
        return new Response("nope", { status: 404 });
      }),
    );

    const tools = createHostTools({ config, knowledgebase: site });
    const list = tools.find((tool) => tool.name === "knowledgebase_list")!;
    const get = tools.find((tool) => tool.name === "knowledgebase_get")!;
    const context = { name: "t", argumentsJson: "{}", signal: new AbortController().signal };

    const listed = await list.handler({ prefix: "/docs" }, { ...context, name: "knowledgebase_list" });
    expect(listed).toMatchObject({ isError: false });
    expect(String((listed as { output: string }).output)).toContain("/docs/faq");
    expect(String((listed as { output: string }).output)).toContain("FAQ");

    const page = await get.handler({ path: "/docs/faq" }, { ...context, name: "knowledgebase_get" });
    expect(page).toMatchObject({ isError: false });
    expect(String((page as { output: string }).output)).toContain("Answers.");
  });
});
