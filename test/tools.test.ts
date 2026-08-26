import { afterEach, describe, expect, it, vi } from "vitest";
import { createHostTools } from "../src/agent/tools.js";
import type { ToolCompletion, ToolInvocation } from "../src/agent/tools.js";
import type { Config } from "../src/config.js";

const config: Config = {
  defaultModel: "alibaba/qwen3.7-flash",
  maxAgentSteps: 8,
  search: { provider: "ddg" },
};

const ddgPage = `
<div class="result results_links">
  <h2 class="result__title">
    <a class="result__a" href="https://ziglang.org/download/">Zig downloads</a>
  </h2>
  <a class="result__snippet" href="https://ziglang.org/download/">0.16.0 is the latest release</a>
</div>`;

function tools(): {
  declarations: ReturnType<typeof createHostTools>;
  started: ToolInvocation[];
  finished: ToolCompletion[];
} {
  const started: ToolInvocation[] = [];
  const finished: ToolCompletion[] = [];
  const declarations = createHostTools({
    config,
    hooks: {
      onStart: (invocation) => started.push(invocation),
      onFinish: (completion) => finished.push(completion),
    },
  });
  return { declarations, started, finished };
}

function tool(name: string) {
  const found = tools().declarations.find((declaration) => declaration.name === name);
  if (!found) throw new Error(`missing tool ${name}`);
  return found;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("host tool declarations", () => {
  it("declares exactly web_search and web_fetch as read-only object schemas", () => {
    const declarations = createHostTools({ config });
    expect(declarations.map((declaration) => declaration.name)).toEqual(["web_search", "web_fetch"]);
    for (const declaration of declarations) {
      expect(declaration.readOnly).toBe(true);
      expect(declaration.parameters.type).toBe("object");
      expect(declaration.parameters.additionalProperties).toBe(false);
      expect(declaration.description.length).toBeGreaterThan(40);
    }
  });

  it("constrains the arguments a model may send", () => {
    const search = tool("web_search").parameters;
    expect(search.required).toEqual(["query"]);
    const properties = search.properties as Record<string, Record<string, unknown>>;
    expect(Object.keys(properties)).toEqual(["query", "count", "site", "freshness"]);
    expect(properties.query?.maxLength).toBe(400);
    expect(properties.count).toMatchObject({ type: "integer", minimum: 1, maximum: 20 });
    expect(properties.freshness?.enum).toEqual(["day", "week", "month", "year"]);

    const fetchParams = tool("web_fetch").parameters;
    expect(fetchParams.required).toEqual(["url"]);
  });
});

describe("web_search handler", () => {
  it("renders results and reports the count through the hooks", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(ddgPage, { status: 200 })));
    const { declarations, started, finished } = tools();
    const search = declarations[0]!;

    const result = await search.handler({ query: "zig latest release" }, context("web_search"));

    expect(result).toMatchObject({ isError: false });
    expect(String((result as { output: string }).output)).toContain("https://ziglang.org/download/");
    expect(started[0]).toMatchObject({ tool: "web_search", query: "zig latest release" });
    expect(finished[0]).toMatchObject({ isError: false, resultCount: 1, summary: "1 results" });
  });

  it("maps the schema's freshness words to the provider's codes", async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init: RequestInit) => {
        calls.push(String(init.body));
        return new Response(ddgPage, { status: 200 });
      }),
    );
    const search = tool("web_search");
    await search.handler({ query: "zig", site: "ziglang.org" }, context("web_search"));
    expect(calls[0]).toContain("site%3Aziglang.org");
  });

  it("reports a provider failure as a tool error rather than throwing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("nope", { status: 503 })));
    const { declarations, finished } = tools();

    const result = await declarations[0]!.handler({ query: "zig" }, context("web_search"));

    expect(result).toMatchObject({ isError: true });
    expect(String((result as { output: string }).output)).toContain("web_search:");
    expect(finished[0]?.isError).toBe(true);
  });
});

describe("web_fetch handler", () => {
  it("refuses a private host without reaching the network", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    const { declarations, finished } = tools();

    const result = await declarations[1]!.handler({ url: "http://127.0.0.1/secrets" }, context("web_fetch"));

    expect(result).toMatchObject({ isError: true });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(finished[0]).toMatchObject({ tool: "web_fetch", isError: true });
  });
});

function context(name: string) {
  return { name, argumentsJson: "{}", signal: new AbortController().signal };
}
