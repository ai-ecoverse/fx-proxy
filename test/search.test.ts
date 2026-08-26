import { describe, expect, it } from "vitest";
import { parseDuckDuckGo } from "../src/tools/search.js";
import { assertFetchableUrl } from "../src/tools/fetchPage.js";
import { htmlToText } from "../src/util/text.js";

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
