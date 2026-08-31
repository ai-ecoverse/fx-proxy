import { describe, expect, it } from "vitest";
import { callWorker } from "./harness.js";

/**
 * The success path, against the real model gateway.
 *
 * Every other suite drives fx to a terminal gateway status, because fx speaks
 * Vercel's AI-SDK wire protocol and no offline mock completes a turn. These
 * tests let the worker reach the network, so they need a credential and cost
 * a few tokens per run:
 *
 *   AI_GATEWAY_API_KEY=vck_… npm test
 *
 * Without the variable they skip, so the default suite stays offline and free.
 * The model is the cheap default; searches run through keyless ddg so nothing
 * bills twice.
 */
const key = process.env.AI_GATEWAY_API_KEY;
const model = process.env.FX_E2E_MODEL ?? "alibaba/qwen3.7-flash";
const live = (body: unknown) =>
  callWorker({
    live: true,
    headers: { authorization: `Bearer ${key}` },
    env: { SEARCH_PROVIDER: "ddg", DEFAULT_MODEL: model },
    body: JSON.stringify(body),
  });

describe.skipIf(!key)("live gateway", () => {
  it("completes a turn and returns the model's answer", { timeout: 180_000 }, async () => {
    const r = await live({ input: "Reply with exactly the word: pearl" });
    const json = r.json as any;
    expect(r.status).toBe(200);
    expect(json.status).toBe("completed");
    expect(json.error).toBeNull();
    expect(json.fx.stop_reason).toBe("end_turn");
    expect(json.model).toBe(model);
    expect(json.output_text.toLowerCase()).toContain("pearl");
    // the assistant message is a real output item, not just output_text
    expect(json.output.at(-1)).toMatchObject({ type: "message", role: "assistant", status: "completed" });
  });

  it("runs a host tool when the model asks for one", { timeout: 240_000 }, async () => {
    const r = await live({
      input: "Use web_search to find the official Zig language homepage, then reply with only its URL.",
    });
    const json = r.json as any;
    expect(json.status).toBe("completed");
    expect(json.fx.tool_calls).toBeGreaterThan(0);

    // fx called the gate, the supervisor served it, and the search really ran
    const searches = json.output.filter((i: any) => i.type === "web_search_call");
    expect(searches.length).toBeGreaterThan(0);
    expect(searches[0].status).toBe("completed");
    expect(searches[0].action.type).toBe("search");
    expect(r.fetches.some((f) => f.url.includes("duckduckgo.com"))).toBe(true);
    expect(json.output_text).toContain("ziglang.org");
  });

  it("streams the Responses event sequence", { timeout: 180_000 }, async () => {
    const r = await callWorker({
      live: true,
      headers: { authorization: `Bearer ${key}` },
      env: { SEARCH_PROVIDER: "ddg", DEFAULT_MODEL: model },
      body: JSON.stringify({ input: "Count 1 to 5 separated by spaces. Nothing else.", stream: true }),
    });
    expect(r.streamed).toBe(true);

    const events = r.sse.map((e) => e.event);
    expect(events[0]).toBe("response.created");
    expect(events[1]).toBe("response.in_progress");
    expect(events.at(-1)).toBe("response.completed");
    expect(r.sse.every((e, i) => e.data.sequence_number === i + 1)).toBe(true);

    // fx streams the turn, so the text arrives in more than one delta
    const deltas = r.sse.filter((e) => e.event === "response.output_text.delta");
    expect(deltas.length).toBeGreaterThan(1);
    const streamed = deltas.map((e) => e.data.delta).join("");
    expect(streamed).toContain("5");

    const final = r.sse.at(-1)!.data.response;
    expect(final.status).toBe("completed");
    expect(final.output_text).toBe(streamed);
  });
});
