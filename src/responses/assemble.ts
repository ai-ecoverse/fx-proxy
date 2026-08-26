import type { AgentEvent } from "../agent/run.js";
import type {
  MessageItem,
  OutputItem,
  ReasoningItem,
  ResponseObject,
  StreamEvent,
  WebSearchCallItem,
} from "./types.js";

export interface AssemblerOptions {
  id: string;
  model: string;
  createdAt: number;
  instructions?: string;
  metadata: Record<string, string>;
  maxOutputTokens?: number;
  runtime: string;
}

/**
 * Turns the fx agent event stream into Responses API output items, producing the
 * streaming events and the final response object from the same state.
 */
export class ResponseAssembler {
  #options: AssemblerOptions;
  #items: OutputItem[] = [];
  #openMessage?: { index: number; item: MessageItem };
  #openReasoning?: { index: number; item: ReasoningItem };
  #tools = new Map<string, { index: number; item: WebSearchCallItem }>();
  #sequence = 0;
  #toolCalls = 0;
  #error?: { code: string; message: string };
  #status: ResponseObject["status"] = "in_progress";
  #incomplete?: string;
  #stopReason = "unknown";
  #modelRequests = 0;

  constructor(options: AssemblerOptions) {
    this.#options = options;
  }

  start(): StreamEvent[] {
    return [
      this.#event("response.created", { response: this.snapshot() }),
      this.#event("response.in_progress", { response: this.snapshot() }),
    ];
  }

  handle(event: AgentEvent): StreamEvent[] {
    switch (event.type) {
      case "text":
        return [...this.#closeReasoning(), ...this.#appendText(event.delta)];
      case "reasoning":
        return [...this.#closeMessage(), ...this.#appendReasoning(event.delta)];
      case "tool.start": {
        const events = [...this.#closeMessage(), ...this.#closeReasoning()];
        this.#toolCalls += 1;
        const { invocation } = event;
        const item: WebSearchCallItem = {
          id: `ws_${invocation.id}`,
          type: "web_search_call",
          status: "in_progress",
          action:
            invocation.tool === "web_fetch" || invocation.tool === "knowledgebase_get"
              ? { type: "open_page", url: invocation.url ?? invocation.path ?? "" }
              : { type: "search", query: invocation.query ?? invocation.path ?? "" },
        };
        const index = this.#push(item);
        this.#tools.set(invocation.id, { index, item });
        return [
          ...events,
          this.#event("response.output_item.added", { output_index: index, item }),
          this.#event("response.web_search_call.in_progress", {
            output_index: index,
            item_id: item.id,
          }),
          this.#event("response.web_search_call.searching", {
            output_index: index,
            item_id: item.id,
          }),
        ];
      }
      case "tool.end": {
        const tracked = this.#tools.get(event.completion.id);
        if (!tracked) return [];
        this.#tools.delete(event.completion.id);
        tracked.item.status = event.completion.isError ? "failed" : "completed";
        const events: StreamEvent[] = [
          this.#event("response.web_search_call.completed", {
            output_index: tracked.index,
            item_id: tracked.item.id,
          }),
        ];
        events.push(
          this.#event("response.output_item.done", {
            output_index: tracked.index,
            item: tracked.item,
          }),
        );
        return events;
      }
      case "error":
        this.#error = { code: event.code ?? "fx_runtime_error", message: event.message };
        return [];
      case "done":
        this.#stopReason = event.stopReason;
        this.#modelRequests = event.modelRequests;
        return [];
      case "trace":
        return [];
    }
  }

  /** Closes open items and emits the terminal event for the response. */
  finish(): StreamEvent[] {
    const events = [...this.#closeMessage(), ...this.#closeReasoning()];
    for (const [id, tracked] of [...this.#tools.entries()]) {
      this.#tools.delete(id);
      tracked.item.status = "failed";
      events.push(
        this.#event("response.output_item.done", {
          output_index: tracked.index,
          item: tracked.item,
        }),
      );
    }

    if (this.#error) {
      this.#status = "failed";
    } else if (this.#stopReason === "cancelled") {
      this.#status = "cancelled";
    } else if (this.#stopReason === "max_tokens") {
      this.#status = "incomplete";
      this.#incomplete = "max_output_tokens";
    } else if (this.#stopReason === "refusal") {
      this.#status = "completed";
    } else {
      this.#status = "completed";
    }

    const response = this.snapshot();
    const terminal =
      this.#status === "failed"
        ? "response.failed"
        : this.#status === "incomplete"
          ? "response.incomplete"
          : "response.completed";
    events.push(this.#event(terminal, { response }));
    return events;
  }

  snapshot(): ResponseObject {
    const outputText = this.#items
      .filter((item): item is MessageItem => item.type === "message")
      .flatMap((item) => item.content.map((part) => part.text))
      .join("");

    return {
      id: this.#options.id,
      object: "response",
      created_at: this.#options.createdAt,
      status: this.#status,
      background: false,
      error: this.#error ?? null,
      incomplete_details: this.#incomplete ? { reason: this.#incomplete } : null,
      instructions: this.#options.instructions ?? null,
      max_output_tokens: this.#options.maxOutputTokens ?? null,
      metadata: this.#options.metadata,
      model: this.#options.model,
      output: this.#items,
      output_text: outputText,
      parallel_tool_calls: false,
      previous_response_id: null,
      store: false,
      temperature: null,
      tool_choice: "auto",
      tools: [{ type: "web_search" }],
      top_p: null,
      truncation: "disabled",
      usage: {
        input_tokens: 0,
        input_tokens_details: { cached_tokens: 0 },
        output_tokens: 0,
        output_tokens_details: { reasoning_tokens: 0 },
        total_tokens: 0,
      },
      user: null,
      fx: {
        stop_reason: this.#stopReason,
        model_requests: this.#modelRequests,
        tool_calls: this.#toolCalls,
        agent: "fx",
        runtime: this.#options.runtime,
      },
    };
  }

  #push(item: OutputItem): number {
    this.#items.push(item);
    return this.#items.length - 1;
  }

  #event(type: string, detail: Record<string, unknown>): StreamEvent {
    this.#sequence += 1;
    return { type, sequence_number: this.#sequence, ...detail };
  }

  #appendText(delta: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (!this.#openMessage) {
      const item: MessageItem = {
        id: `msg_${this.#items.length}_${this.#options.id.slice(-8)}`,
        type: "message",
        status: "in_progress",
        role: "assistant",
        content: [{ type: "output_text", text: "", annotations: [] }],
      };
      const index = this.#push(item);
      this.#openMessage = { index, item };
      events.push(
        this.#event("response.output_item.added", { output_index: index, item }),
        this.#event("response.content_part.added", {
          item_id: item.id,
          output_index: index,
          content_index: 0,
          part: { type: "output_text", text: "", annotations: [] },
        }),
      );
    }
    const open = this.#openMessage;
    open.item.content[0]!.text += delta;
    events.push(
      this.#event("response.output_text.delta", {
        item_id: open.item.id,
        output_index: open.index,
        content_index: 0,
        delta,
      }),
    );
    return events;
  }

  #closeMessage(): StreamEvent[] {
    const open = this.#openMessage;
    if (!open) return [];
    this.#openMessage = undefined;
    open.item.status = "completed";
    const text = open.item.content[0]!.text;
    return [
      this.#event("response.output_text.done", {
        item_id: open.item.id,
        output_index: open.index,
        content_index: 0,
        text,
      }),
      this.#event("response.content_part.done", {
        item_id: open.item.id,
        output_index: open.index,
        content_index: 0,
        part: { type: "output_text", text, annotations: [] },
      }),
      this.#event("response.output_item.done", { output_index: open.index, item: open.item }),
    ];
  }

  #appendReasoning(delta: string): StreamEvent[] {
    const events: StreamEvent[] = [];
    if (!this.#openReasoning) {
      const item: ReasoningItem = {
        id: `rs_${this.#items.length}_${this.#options.id.slice(-8)}`,
        type: "reasoning",
        status: "in_progress",
        summary: [{ type: "summary_text", text: "" }],
      };
      const index = this.#push(item);
      this.#openReasoning = { index, item };
      events.push(
        this.#event("response.output_item.added", { output_index: index, item }),
        this.#event("response.reasoning_summary_part.added", {
          item_id: item.id,
          output_index: index,
          summary_index: 0,
          part: { type: "summary_text", text: "" },
        }),
      );
    }
    const open = this.#openReasoning;
    open.item.summary[0]!.text += delta;
    events.push(
      this.#event("response.reasoning_summary_text.delta", {
        item_id: open.item.id,
        output_index: open.index,
        summary_index: 0,
        delta,
      }),
    );
    return events;
  }

  #closeReasoning(): StreamEvent[] {
    const open = this.#openReasoning;
    if (!open) return [];
    this.#openReasoning = undefined;
    open.item.status = "completed";
    const text = open.item.summary[0]!.text;
    return [
      this.#event("response.reasoning_summary_text.done", {
        item_id: open.item.id,
        output_index: open.index,
        summary_index: 0,
        text,
      }),
      this.#event("response.reasoning_summary_part.done", {
        item_id: open.item.id,
        output_index: open.index,
        summary_index: 0,
        part: { type: "summary_text", text },
      }),
      this.#event("response.output_item.done", { output_index: open.index, item: open.item }),
    ];
  }
}
