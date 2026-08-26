import { createFxAgent } from "libfx/wasm";
import type { FxPromptBlock, FxSessionUpdate } from "libfx/wasm";
import type { Config } from "../config.js";
import { AsyncQueue } from "../util/queue.js";
import { createGatewayFetch } from "./gateway.js";
import type { GatewayStats } from "./gateway.js";
import { createSandboxWorkspace } from "./shell.js";
import type { ToolCompletion, ToolInvocation } from "./shell.js";

export type AgentEvent =
  | { type: "text"; delta: string }
  | { type: "reasoning"; delta: string }
  | { type: "tool.start"; invocation: ToolInvocation }
  | { type: "tool.end"; completion: ToolCompletion }
  | { type: "trace"; update: FxSessionUpdate }
  | { type: "error"; message: string; code?: string }
  | { type: "done"; stopReason: string; modelRequests: number };

export interface RunOptions {
  wasm: WebAssembly.Module;
  config: Config;
  credentials: { gatewayApiKey: string };
  model: string;
  prompt: FxPromptBlock[];
  signal?: AbortSignal;
  onRuntimeLog?(message: string): void;
}

const closeTimeoutMs = 3_000;

export async function* runAgent(options: RunOptions): AsyncGenerator<AgentEvent> {
  const queue = new AsyncQueue<AgentEvent>();
  const stats: GatewayStats = { requests: 0, authFailures: 0 };
  const decoder = new TextDecoder();

  const workspace = createSandboxWorkspace({
    config: options.config,
    hooks: {
      onStart: (invocation) => queue.push({ type: "tool.start", invocation }),
      onFinish: (completion) => queue.push({ type: "tool.end", completion }),
    },
  });

  const agent = await createFxAgent({
    wasm: options.wasm,
    env: {
      AI_GATEWAY_API_KEY: options.credentials.gatewayApiKey,
      FX_MODEL: options.model,
      FX_MAX_AGENT_STEPS: String(options.config.maxAgentSteps),
      ...(options.config.gatewayBaseUrl
        ? { FX_GATEWAY_BASE_URL: options.config.gatewayBaseUrl }
        : {}),
    },
    fetch: createGatewayFetch(options.config, options.credentials, stats),
    workspace,
    stderr: (chunk) => options.onRuntimeLog?.(decoder.decode(chunk)),
    // The sandbox cannot touch anything durable, so every request is granted.
    onPermission: (request) => {
      const preferred = request.options?.find((option) =>
        option.kind?.startsWith("allow") || option.optionId.startsWith("allow"),
      );
      return preferred?.optionId ?? request.options?.[0]?.optionId ?? null;
    },
  });

  const session = await agent.createSession();
  if (session.configOptions.some((option) => option.id === "model")) {
    try {
      await session.setModel(options.model);
    } catch (error) {
      options.onRuntimeLog?.(`model selection failed: ${describeError(error)}`);
    }
  }

  const turn = session.prompt(options.prompt, { signal: options.signal });

  void (async () => {
    try {
      for await (const update of turn) {
        translate(update, queue);
      }
      const { stopReason } = await turn.result;
      if (stats.authFailures > 0) {
        queue.push({
          type: "error",
          code: "invalid_api_key",
          message:
            "the upstream model gateway rejected the credential (HTTP 401/403); check the AI Gateway API key",
        });
      }
      queue.push({ type: "done", stopReason, modelRequests: stats.requests });
    } catch (error) {
      queue.push({ type: "error", message: describeError(error) });
      queue.push({ type: "done", stopReason: "error", modelRequests: stats.requests });
    } finally {
      queue.close();
    }
  })();

  try {
    for await (const event of queue) {
      yield event;
      if (event.type === "done") break;
    }
  } finally {
    queue.close();
    turn.cancel();
    await shutdown(agent);
  }
}

function translate(update: FxSessionUpdate, queue: AsyncQueue<AgentEvent>): void {
  switch (update.sessionUpdate) {
    case "agent_message_chunk": {
      const delta = textOf(update);
      if (delta) queue.push({ type: "text", delta });
      return;
    }
    case "agent_thought_chunk": {
      const delta = textOf(update);
      if (delta) queue.push({ type: "reasoning", delta });
      return;
    }
    default:
      queue.push({ type: "trace", update });
  }
}

function textOf(update: FxSessionUpdate): string | undefined {
  const content = update.content;
  if (!content) return undefined;
  return typeof content.text === "string" && content.text.length > 0 ? content.text : undefined;
}

async function shutdown(agent: { close(): Promise<number>; abort(): void }): Promise<void> {
  const timeout = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), closeTimeoutMs));
  try {
    const outcome = await Promise.race([agent.close().then(() => "closed" as const), timeout]);
    if (outcome === "timeout") agent.abort();
  } catch {
    agent.abort();
  }
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
