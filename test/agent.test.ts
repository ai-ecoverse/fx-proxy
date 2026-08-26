import { describe, expect, it } from "vitest";
import { callWorker } from "./harness.js";
import type { MockRequest, MockResponse } from "./harness.js";

const answer = (text: string, extra: Record<string, unknown> = {}): MockResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    choices: [{ finish_reason: "stop", message: { content: text, ...extra } }],
    usage: { prompt_tokens: 10, completion_tokens: 5 },
  }),
});

const toolTurn = (name: string, args: unknown): MockResponse => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify({
    choices: [
      {
        message: {
          tool_calls: [{ id: "call_1", function: { name, arguments: JSON.stringify(args) } }],
        },
      },
    ],
    usage: { prompt_tokens: 100, completion_tokens: 20 },
  }),
});

describe("agent loop", () => {
  it("runs a search tool call and assembles the response", () => {
    let call = 0;
    const r = callWorker({
      headers: { authorization: "Bearer key" },
      body: JSON.stringify({ input: "What changed in Zig 0.16?", metadata: { a: "b" } }),
      env: { SEARCH_PROVIDER: "ddg", DEFAULT_MODEL: "test/model" },
      fetchMock: (req) => {
        if (req.url.includes("ai-gateway.vercel.sh")) {
          call++;
          return call === 1 ? toolTurn("web_search", { query: "zig 0.16 changes" }) : answer("Zig changed.");
        }
        if (req.url.includes("duckduckgo.com")) {
          return {
            status: 200,
            contentType: "text/html",
            body:
              '<a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fziglang.org%2Fnews%2F&rut=x">Zig News</a>' +
              '<a class="result__snippet" href="#">Release notes</a>',
          };
        }
        return { status: 599, body: "unexpected " + req.url };
      },
    });
    expect(r.status).toBe(200);
    const json = r.json as any;
    expect(json.status).toBe("completed");
    expect(json.model).toBe("test/model");
    expect(json.metadata).toEqual({ a: "b" });
    expect(json.output[0]).toMatchObject({
      type: "web_search_call",
      status: "completed",
      action: { type: "search", query: "zig 0.16 changes" },
    });
    expect(json.output[1].content[0].text).toBe("Zig changed.");
    expect(json.output_text).toBe("Zig changed.");
    expect(json.usage.total_tokens).toBe(135);
    expect(json.fx).toMatchObject({
      stop_reason: "end_turn",
      model_requests: 2,
      tool_calls: 1,
      agent: "hotglue",
    });
    // the tool result reached the second model call
    const second = JSON.parse(r.fetches.filter((f) => f.url.includes("gateway"))[1]!.body);
    expect(second.messages.map((m: any) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
    expect(second.messages[3].content).toContain("https://ziglang.org/news/");
  });

  it("replays multi-turn input as a transcript", () => {
    let gw: MockRequest | undefined;
    callWorker({
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({
        input: [
          { role: "user", content: "first question" },
          { role: "assistant", content: [{ type: "output_text", text: "first answer" }] },
          "follow-up?",
        ],
        instructions: "Be terse.",
      }),
      fetchMock: (req) => {
        gw = req;
        return answer("ok");
      },
    });
    const body = JSON.parse(gw!.body);
    expect(body.messages[0].content).toContain("<fx-proxy-runtime>");
    expect(body.messages[0].content).toContain("Be terse.");
    expect(body.messages[1].content).toBe(
      "<conversation>\n<user>\nfirst question\n</user>\n<assistant>\nfirst answer\n</assistant>\n<user>\nfollow-up?\n</user>\n</conversation>\n\nContinue the conversation above and answer the final user message.",
    );
  });

  it("maps upstream 401 to invalid_api_key", () => {
    const r = callWorker({
      headers: { authorization: "Bearer bad" },
      body: JSON.stringify({ input: "x" }),
      fetchMock: () => ({ status: 401, body: "{}" }),
    });
    expect(r.status).toBe(401);
    expect((r.json as any).error.code).toBe("invalid_api_key");
    expect((r.json as any).status).toBe("failed");
  });

  it("stops at MAX_AGENT_STEPS", () => {
    const r = callWorker({
      headers: { authorization: "Bearer k" },
      env: { MAX_AGENT_STEPS: "2" },
      body: JSON.stringify({ input: "x" }),
      fetchMock: (req) =>
        req.url.includes("gateway")
          ? toolTurn("web_fetch", { url: "https://example.com/" })
          : { status: 200, contentType: "text/html", body: "<html><p>page</p></html>" },
    });
    const json = r.json as any;
    expect(json.fx.stop_reason).toBe("max_agent_steps");
    expect(json.fx.model_requests).toBe(2);
    expect(json.fx.tool_calls).toBe(2);
    expect(json.output[0].action).toEqual({ type: "open_page", url: "https://example.com/" });
  });

  it("surfaces reasoning as a reasoning item", () => {
    const r = callWorker({
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ input: "x" }),
      fetchMock: () => answer("final", { reasoning_content: "thinking" }),
    });
    const json = r.json as any;
    expect(json.output[0]).toMatchObject({ type: "reasoning", status: "completed" });
    expect(json.output[0].summary[0].text).toBe("thinking");
    expect(json.output[1].content[0].text).toBe("final");
  });
});

describe("streaming", () => {
  it("emits the Responses SSE sequence", () => {
    const r = callWorker({
      headers: { authorization: "Bearer k" },
      body: JSON.stringify({ input: "hi", stream: true }),
      fetchMock: () => answer("Hello!", { reasoning_content: "hmm" }),
    });
    expect(r.streamed).toBe(true);
    expect(r.sse.map((e) => e.event)).toEqual([
      "response.created",
      "response.in_progress",
      "response.output_item.added",
      "response.reasoning_summary_part.added",
      "response.reasoning_summary_text.delta",
      "response.reasoning_summary_text.done",
      "response.reasoning_summary_part.done",
      "response.output_item.done",
      "response.output_item.added",
      "response.content_part.added",
      "response.output_text.delta",
      "response.output_text.done",
      "response.content_part.done",
      "response.output_item.done",
      "response.completed",
    ]);
    expect(r.sse.every((e, i) => e.data.sequence_number === i + 1)).toBe(true);
    const final = r.sse.at(-1)!.data.response;
    expect(final.status).toBe("completed");
    expect(final.output_text).toBe("Hello!");
  });
});
