import type { FxPromptBlock } from "libfx/wasm";
import { toolManual } from "../agent/prompt.js";
import type { Knowledgebase } from "../tools/knowledgebase.js";
import type { ResponsesRequestBody } from "./types.js";

export class RequestError extends Error {
  readonly status: number;
  readonly code: string;
  readonly param?: string;

  constructor(message: string, options: { status?: number; code?: string; param?: string } = {}) {
    super(message);
    this.status = options.status ?? 400;
    this.code = options.code ?? "invalid_request_error";
    this.param = options.param;
  }
}

export interface ParsedRequest {
  model?: string;
  instructions?: string;
  stream: boolean;
  metadata: Record<string, string>;
  include: string[];
  maxOutputTokens?: number;
  prompt: FxPromptBlock[];
  /** Rendered transcript, kept for debugging and tests. */
  promptText: string;
}

export function parseResponsesRequest(
  body: ResponsesRequestBody,
  options: { knowledgebase?: Knowledgebase } = {},
): ParsedRequest {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    throw new RequestError("request body must be a JSON object");
  }
  if (body.previous_response_id !== undefined && body.previous_response_id !== null) {
    throw new RequestError(
      "previous_response_id is not supported yet: fx-proxy does not persist conversations",
      { param: "previous_response_id", code: "unsupported_parameter" },
    );
  }
  if (body.model !== undefined && body.model !== null && typeof body.model !== "string") {
    throw new RequestError("model must be a string", { param: "model" });
  }
  if (
    body.instructions !== undefined &&
    body.instructions !== null &&
    typeof body.instructions !== "string"
  ) {
    throw new RequestError("instructions must be a string", { param: "instructions" });
  }
  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== "boolean") {
    throw new RequestError("stream must be a boolean", { param: "stream" });
  }

  const instructions = typeof body.instructions === "string" ? body.instructions : undefined;
  const transcript = renderInput(body.input);
  const promptText = [toolManual(options.knowledgebase), instructions?.trim(), transcript]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");

  return {
    model: typeof body.model === "string" ? body.model : undefined,
    instructions,
    stream: body.stream === true,
    metadata: parseMetadata(body.metadata),
    include: parseInclude(body.include),
    maxOutputTokens: parseMaxOutputTokens(body.max_output_tokens),
    prompt: [{ type: "text", text: promptText }],
    promptText,
  };
}

function parseMetadata(value: unknown): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new RequestError("metadata must be an object of string values", { param: "metadata" });
  }
  const metadata: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry !== "string") {
      throw new RequestError(`metadata.${key} must be a string`, { param: "metadata" });
    }
    metadata[key] = entry;
  }
  return metadata;
}

function parseInclude(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RequestError("include must be an array of strings", { param: "include" });
  }
  return value as string[];
}

function parseMaxOutputTokens(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new RequestError("max_output_tokens must be a positive number", {
      param: "max_output_tokens",
    });
  }
  return Math.floor(value);
}

/**
 * Flattens Responses API input into one fx prompt. fx owns its own session
 * history, so a multi-message conversation is replayed as a transcript with the
 * final user message as the live request.
 */
export function renderInput(input: unknown): string {
  if (input === undefined || input === null) {
    throw new RequestError("input is required", { param: "input" });
  }
  if (typeof input === "string") {
    if (!input.trim()) throw new RequestError("input must not be empty", { param: "input" });
    return input;
  }
  if (!Array.isArray(input)) {
    throw new RequestError("input must be a string or an array of items", { param: "input" });
  }

  const turns: { role: string; text: string }[] = [];
  for (const [index, item] of input.entries()) {
    if (typeof item === "string") {
      turns.push({ role: "user", text: item });
      continue;
    }
    if (item === null || typeof item !== "object") {
      throw new RequestError(`input[${index}] must be an object`, { param: "input" });
    }
    const record = item as Record<string, unknown>;
    const type = typeof record.type === "string" ? record.type : "message";
    if (type === "function_call" || type === "function_call_output" || type === "custom_tool_call") {
      throw new RequestError(
        `input[${index}]: client-side tool results are not supported; fx runs its tools inside the proxy`,
        { param: "input", code: "unsupported_parameter" },
      );
    }
    if (type !== "message" && type !== "input_text" && type !== "output_text") {
      // Unknown item types (reasoning echoes, annotations) carry no prompt text.
      continue;
    }
    const role = typeof record.role === "string" ? record.role : "user";
    const text = renderContent(record.content ?? record.text, index);
    if (text.trim()) turns.push({ role, text });
  }

  if (turns.length === 0) {
    throw new RequestError("input contained no text to send to the model", { param: "input" });
  }
  if (turns.length === 1) return turns[0]!.text;

  const lastUser = [...turns].reverse().find((turn) => turn.role === "user");
  const history = turns
    .map((turn) => `<${turn.role}>\n${turn.text}\n</${turn.role}>`)
    .join("\n");
  return [
    "<conversation>",
    history,
    "</conversation>",
    "",
    lastUser
      ? "Continue the conversation above and answer the final user message."
      : "Continue the conversation above.",
  ].join("\n");
}

function renderContent(content: unknown, index: number): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) {
    throw new RequestError(`input[${index}].content must be a string or an array`, {
      param: "input",
    });
  }
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part === "string") {
      parts.push(part);
      continue;
    }
    if (part === null || typeof part !== "object") continue;
    const record = part as Record<string, unknown>;
    if (record.type === "input_image" || record.type === "input_file") {
      throw new RequestError("image and file inputs are not supported by the fx runtime", {
        param: "input",
        code: "unsupported_parameter",
      });
    }
    if (typeof record.text === "string") parts.push(record.text);
  }
  return parts.join("\n");
}
