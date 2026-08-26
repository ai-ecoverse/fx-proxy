import { runAgent } from "../agent/run.js";
import type { AgentEvent } from "../agent/run.js";
import { resolveCredentials } from "../config.js";
import type { Config } from "../config.js";
import { ResponseAssembler } from "./assemble.js";
import { parseResponsesRequest, RequestError } from "./request.js";
import type { ResponsesRequestBody, StreamEvent } from "./types.js";

export interface HandlerContext {
  wasm: WebAssembly.Module;
  config: Config;
  runtime: string;
  log?(message: string): void;
}

export async function handleResponses(
  request: Request,
  context: HandlerContext,
): Promise<Response> {
  const credentials = resolveCredentials(context.config, request.headers.get("authorization"));

  let body: ResponsesRequestBody;
  try {
    body = (await request.json()) as ResponsesRequestBody;
  } catch {
    throw new RequestError("request body must be valid JSON");
  }

  const parsed = parseResponsesRequest(body);
  const model = parsed.model ?? context.config.defaultModel;
  const assembler = new ResponseAssembler({
    id: `resp_${randomId()}`,
    model,
    createdAt: Math.floor(Date.now() / 1000),
    instructions: parsed.instructions,
    metadata: parsed.metadata,
    maxOutputTokens: parsed.maxOutputTokens,
    includeShellCalls: parsed.include.includes("fx.tool_calls"),
    runtime: context.runtime,
  });

  const events = runAgent({
    wasm: context.wasm,
    config: context.config,
    credentials,
    model,
    prompt: parsed.prompt,
    signal: request.signal,
    onRuntimeLog: (message) => context.log?.(message.trimEnd()),
  });

  if (!parsed.stream) {
    for await (const event of events) assembler.handle(event);
    assembler.finish();
    const response = assembler.snapshot();
    return json(response, statusFor(response.status, response.error?.code));
  }

  return streamResponse(assembler, events, context);
}

function streamResponse(
  assembler: ResponseAssembler,
  events: AsyncGenerator<AgentEvent>,
  context: HandlerContext,
): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const write = async (streamEvents: StreamEvent[]): Promise<void> => {
    for (const event of streamEvents) {
      await writer.write(encoder.encode(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`));
    }
  };

  void (async () => {
    try {
      await write(assembler.start());
      for await (const event of events) {
        await write(assembler.handle(event));
      }
      await write(assembler.finish());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      context.log?.(`stream failed: ${message}`);
      assembler.handle({ type: "error", message });
      await write(assembler.finish()).catch(() => {});
    } finally {
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

function statusFor(status: string, errorCode: string | undefined): number {
  if (status !== "failed") return 200;
  return errorCode === "invalid_api_key" ? 401 : 500;
}

export function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function randomId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
