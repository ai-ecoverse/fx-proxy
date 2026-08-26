import { describe, expect, it } from "vitest";
import { ResponseAssembler } from "../src/responses/assemble.js";
import type { AgentEvent } from "../src/agent/run.js";
import type { StreamEvent } from "../src/responses/types.js";

function assembler(): ResponseAssembler {
  return new ResponseAssembler({
    id: "resp_0123456789abcdef",
    model: "openai/gpt-5",
    createdAt: 1_700_000_000,
    metadata: {},
    runtime: "test",
  });
}

function drive(events: AgentEvent[]): {
  stream: StreamEvent[];
  snapshot: ReturnType<ResponseAssembler["snapshot"]>;
} {
  const target = assembler();
  const stream: StreamEvent[] = [...target.start()];
  for (const event of events) stream.push(...target.handle(event));
  stream.push(...target.finish());
  return { stream, snapshot: target.snapshot() };
}

describe("ResponseAssembler", () => {
  it("emits a search call before the answer message", () => {
    const { stream, snapshot } = drive([
      {
        type: "tool.start",
        invocation: {
          id: "call_001",
          tool: "web_search",
          arguments: { query: "zig" },
          query: "zig",
        },
      },
      {
        type: "tool.end",
        completion: {
          id: "call_001",
          tool: "web_search",
          arguments: { query: "zig" },
          query: "zig",
          isError: false,
          summary: "3 results",
          resultCount: 3,
        },
      },
      { type: "text", delta: "Zig 0.16 " },
      { type: "text", delta: "shipped." },
      { type: "done", stopReason: "end_turn", modelRequests: 2 },
    ]);

    expect(snapshot.status).toBe("completed");
    expect(snapshot.output.map((item) => item.type)).toEqual(["web_search_call", "message"]);
    expect(snapshot.output_text).toBe("Zig 0.16 shipped.");
    expect(snapshot.fx).toMatchObject({ stop_reason: "end_turn", model_requests: 2, tool_calls: 1 });

    const types = stream.map((event) => event.type);
    expect(types[0]).toBe("response.created");
    expect(types).toContain("response.web_search_call.searching");
    expect(types.filter((type) => type === "response.output_text.delta")).toHaveLength(2);
    expect(types.at(-1)).toBe("response.completed");
    expect(stream.map((event) => event.sequence_number)).toEqual(
      stream.map((_event, index) => index + 1),
    );
  });

  it("maps knowledgebase_get to an open_page action", () => {
    const { snapshot } = drive([
      {
        type: "tool.start",
        invocation: {
          id: "call_001",
          tool: "knowledgebase_get",
          arguments: { path: "/docs/faq" },
          path: "/docs/faq",
          url: "/docs/faq",
        },
      },
      { type: "done", stopReason: "end_turn", modelRequests: 1 },
    ]);
    expect(snapshot.output[0]).toMatchObject({
      type: "web_search_call",
      action: { type: "open_page", url: "/docs/faq" },
    });
  });

  it("maps web_fetch to an open_page action", () => {
    const { snapshot } = drive([
      {
        type: "tool.start",
        invocation: {
          id: "call_001",
          tool: "web_fetch",
          arguments: { url: "https://fx.sh" },
          url: "https://fx.sh",
        },
      },
      { type: "done", stopReason: "end_turn", modelRequests: 1 },
    ]);
    expect(snapshot.output[0]).toMatchObject({
      type: "web_search_call",
      status: "failed",
      action: { type: "open_page", url: "https://fx.sh" },
    });
  });

  it("marks a failed tool call without dropping the item", () => {
    const { snapshot } = drive([
      {
        type: "tool.start",
        invocation: { id: "call_001", tool: "web_search", arguments: { query: "zig" }, query: "zig" },
      },
      {
        type: "tool.end",
        completion: {
          id: "call_001",
          tool: "web_search",
          arguments: { query: "zig" },
          query: "zig",
          isError: true,
          summary: "search provider rejected the request",
        },
      },
      { type: "done", stopReason: "end_turn", modelRequests: 1 },
    ]);
    expect(snapshot.output[0]).toMatchObject({
      type: "web_search_call",
      status: "failed",
      action: { type: "search", query: "zig" },
    });
    expect(snapshot.fx.tool_calls).toBe(1);
  });

  it("reports runtime failures", () => {
    const { snapshot, stream } = drive([
      { type: "error", message: "gateway exploded" },
      { type: "done", stopReason: "error", modelRequests: 1 },
    ]);
    expect(snapshot.status).toBe("failed");
    expect(snapshot.error).toEqual({ code: "fx_runtime_error", message: "gateway exploded" });
    expect(stream.at(-1)?.type).toBe("response.failed");
  });
});
