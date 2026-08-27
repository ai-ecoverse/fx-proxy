import { describe, expect, it } from "vitest";
import { callWorker } from "./harness.js";

describe("router", () => {
  it("serves health with CORS", async () => {
    const r = await callWorker({ method: "GET", url: "https://x.test/health", env: { SEARCH_PROVIDER: "ddg" } });
    expect(r.status).toBe(200);
    expect(r.json).toMatchObject({
      service: "fx-proxy",
      agent: "hotglue",
      runtime: "cloudflare-workers",
      search_provider: "ddg",
    });
    expect(r.headers["access-control-allow-origin"]).toBe("*");
  });

  it("serves the model list", async () => {
    const r = await callWorker({ method: "GET", url: "https://x.test/v1/models", env: { DEFAULT_MODEL: "m/x" } });
    expect(r.status).toBe(200);
    expect((r.json as any).data[0].id).toBe("m/x");
  });

  it("answers preflight", async () => {
    const r = await callWorker({ method: "OPTIONS", url: "https://x.test/v1/responses" });
    expect(r.status).toBe(204);
    expect(r.headers["access-control-allow-methods"]).toContain("POST");
  });

  it("404s unknown routes", async () => {
    const r = await callWorker({ method: "GET", url: "https://x.test/nope" });
    expect(r.status).toBe(404);
    expect((r.json as any).error.message).toContain("unknown route: GET /nope");
  });

  it("405s wrong methods with an allow header", async () => {
    const r = await callWorker({ method: "GET", url: "https://x.test/v1/responses" });
    expect(r.status).toBe(405);
    expect(r.headers.allow).toBe("POST, OPTIONS");
  });

  it("rejects an unsupported search provider", async () => {
    const r = await callWorker({ method: "GET", url: "https://x.test/health", env: { SEARCH_PROVIDER: "bing" } });
    expect(r.status).toBe(500);
    expect((r.json as any).error.message).toBe("unsupported SEARCH_PROVIDER: bing");
  });
});

describe("credentials", () => {
  it("requires a credential", async () => {
    const r = await callWorker({ body: "{}" });
    expect(r.status).toBe(401);
    expect((r.json as any).error.message).toContain("missing credentials");
  });

  it("enforces PROXY_API_KEY", async () => {
    const r = await callWorker({
      headers: { authorization: "Bearer wrong" },
      env: { PROXY_API_KEY: "right", AI_GATEWAY_API_KEY: "gw" },
      body: JSON.stringify({ input: "x" }),
    });
    expect(r.status).toBe(401);
    expect((r.json as any).error.message).toBe("invalid API key provided");
  });

  it("passes its own gateway key to fx when the proxy key matches", async () => {
    const r = await callWorker({
      headers: { authorization: "Bearer right" },
      env: { PROXY_API_KEY: "right", AI_GATEWAY_API_KEY: "gw" },
      body: JSON.stringify({ input: "x" }),
      // fx cannot complete a turn against an offline mock; 401 ends it
      fetchMock: () => ({ status: 401, body: "{}" }),
    });
    // every outbound gateway call fx makes carries the resolved key
    const gw = r.fetches.filter((f) => f.url.includes("ai-gateway.vercel.sh"));
    expect(gw.length).toBeGreaterThan(0);
    expect(gw.every((f) => f.headers.authorization === "Bearer gw")).toBe(true);
  });
});

describe("request validation", () => {
  const call = (body: unknown) =>
    callWorker({
      headers: { authorization: "Bearer k" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });

  it("rejects non-JSON bodies", async () => {
    const r = await call("not json");
    expect(r.status).toBe(400);
    expect((r.json as any).error.message).toBe("request body must be valid JSON");
  });

  it("requires input", async () => {
    const r = await call({});
    expect(r.status).toBe(400);
    expect((r.json as any).error.param).toBe("input");
  });

  it("rejects empty string input", async () => {
    const r = await call({ input: "   " });
    expect((r.json as any).error.message).toBe("input must not be empty");
  });

  it("rejects previous_response_id", async () => {
    const r = await call({ input: "x", previous_response_id: "resp_1" });
    expect((r.json as any).error.type).toBe("unsupported_parameter");
  });

  it("rejects a non-string model", async () => {
    const r = await call({ input: "x", model: 5 });
    expect((r.json as any).error.message).toBe("model must be a string");
  });

  it("rejects non-string metadata values", async () => {
    const r = await call({ input: "x", metadata: { a: 1 } });
    expect((r.json as any).error.message).toBe("metadata.a must be a string");
  });

  it("rejects bad max_output_tokens", async () => {
    const r = await call({ input: "x", max_output_tokens: -5 });
    expect((r.json as any).error.message).toBe("max_output_tokens must be a positive number");
  });

  it("rejects client-side tool results", async () => {
    const r = await call({ input: [{ type: "function_call", name: "x" }] });
    expect((r.json as any).error.type).toBe("unsupported_parameter");
    expect((r.json as any).error.message).toContain("client-side tool results");
  });

  it("rejects image inputs", async () => {
    const r = await call({ input: [{ role: "user", content: [{ type: "input_image", url: "x" }] }] });
    expect((r.json as any).error.type).toBe("unsupported_parameter");
  });

  it("rejects malformed knowledge-base headers", async () => {
    const r = await callWorker({
      headers: { authorization: "Bearer k", "x-org": "or--g", "x-repo": "site" },
      body: JSON.stringify({ input: "x" }),
    });
    expect(r.status).toBe(400);
    expect((r.json as any).error.param).toBe("headers");
  });
});
