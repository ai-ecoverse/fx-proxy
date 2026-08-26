import { describe, expect, it } from "vitest";
import { CommandSyntaxError, flagNumber, parseCommand, tokenize } from "../src/util/args.js";

describe("tokenize", () => {
  it("keeps quoted phrases together", () => {
    expect(tokenize('web_search "wrangler jspi support"')).toEqual([
      "web_search",
      "wrangler jspi support",
    ]);
  });

  it("supports single quotes and backslash escapes", () => {
    expect(tokenize("echo 'a b' c\\ d")).toEqual(["echo", "a b", "c d"]);
  });

  it("rejects unterminated quotes", () => {
    expect(() => tokenize('web_search "open')).toThrow(CommandSyntaxError);
  });
});

describe("parseCommand", () => {
  it("splits flags from positional arguments", () => {
    const parsed = parseCommand('web_search "zig 0.16" --count=3 --json');
    expect(parsed.name).toBe("web_search");
    expect(parsed.args).toEqual(["zig 0.16"]);
    expect(parsed.flags).toEqual({ count: "3", json: true });
  });

  it("rejects shell operators", () => {
    expect(() => parseCommand("web_search foo | head")).toThrow(CommandSyntaxError);
  });
});

describe("flagNumber", () => {
  it("clamps to the maximum", () => {
    expect(flagNumber({ count: "500" }, "count", 6, 20)).toBe(20);
  });

  it("falls back on garbage", () => {
    expect(flagNumber({ count: "abc" }, "count", 6, 20)).toBe(6);
    expect(flagNumber({}, "count", 6, 20)).toBe(6);
  });
});
