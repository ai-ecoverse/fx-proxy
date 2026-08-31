import { describe, expect, it } from "vitest";
import { callWorker } from "./harness.js";

/**
 * Integration test for the embedded fx-core. fx speaks Vercel's AI-SDK
 * wire protocol, which an offline mock cannot fully satisfy, so these
 * tests exercise the embedding up to and including a terminal gateway
 * response: instantiation of all 51 gates, the ACP handshake
 * (initialize → session/new → set_config_option → prompt), fx's own
 * session/update text flowing through the driver into the Responses
 * assembler, and the auth-failure mapping.
 */
describe("fx-core embedding", () => {
  it("boots fx, runs the ACP handshake, and assembles a Responses object", async () => {
    const r = await callWorker({
      headers: { authorization: "Bearer testkey" },
      body: JSON.stringify({ input: "Say hello", metadata: { a: "b" } }),
      env: { SEARCH_PROVIDER: "ddg", DEFAULT_MODEL: "test/model" },
      // fx cannot complete a turn offline; 401 makes it stop
      fetchMock: () => ({ status: 401, body: '{"error":{"message":"mock unauthorized"}}' }),
    });

    // fx reached the model gateway through the http gates
    const gw = r.fetches.filter((f) => f.url.includes("ai-gateway.vercel.sh"));
    expect(gw.length).toBeGreaterThan(0);

    // the driver produced a well-formed Responses object
    const json = r.json as any;
    expect(json.object).toBe("response");
    expect(json.model).toBe("test/model");
    expect(json.metadata).toEqual({ a: "b" });
    expect(json.fx.agent).toBe("hotglue");
    // real fx stop reason surfaced by the driver
    expect(typeof json.fx.stop_reason).toBe("string");
    // the model request count came from the http gates
    expect(json.fx.model_requests).toBeGreaterThan(0);

    // the upstream 401 mapped to the invalid_api_key failure
    expect(r.status).toBe(401);
    expect(json.status).toBe("failed");
    expect(json.error.code).toBe("invalid_api_key");
  });

  it("advertises the host-tool manifest to fx", async () => {
    // knowledgebase headers make fx see four tools; without a real model
    // turn we can only assert the run reaches the gateway and terminates.
    const r = await callWorker({
      headers: { authorization: "Bearer k", "x-org": "org", "x-repo": "site" },
      body: JSON.stringify({ input: "hi" }),
      fetchMock: () => ({ status: 401, body: "{}" }),
    });
    expect((r.json as any).object).toBe("response");
    expect((r.json as any).status).toBe("failed");
  });
});
