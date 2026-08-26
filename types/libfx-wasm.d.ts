/**
 * Types for the `libfx/wasm` host layer (`fx-sdk.js`), which ships untyped.
 * Mapped in via tsconfig `paths`.
 */

export interface FxContentBlock {
  type: string;
  text?: string;
  [key: string]: unknown;
}

/** ACP `session/update` payload. fx discriminates on `sessionUpdate`. */
export interface FxSessionUpdate {
  sessionUpdate: string;
  content?: FxContentBlock;
  toolCallId?: string;
  title?: string;
  kind?: string;
  status?: string;
  rawInput?: unknown;
  rawOutput?: unknown;
  [key: string]: unknown;
}

export type FxPromptBlock =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; text?: string } };

export interface FxTurn extends AsyncIterable<FxSessionUpdate> {
  readonly stopReason: Promise<string>;
  readonly result: Promise<{ stopReason: string }>;
  cancel(): void;
}

export interface FxConfigOption {
  id: string;
  currentValue?: string;
  availableValues?: { id: string }[];
}

export interface FxSession {
  readonly id: string;
  readonly configOptions: FxConfigOption[];
  prompt(input: string | FxPromptBlock[], options?: { signal?: AbortSignal }): FxTurn;
  setModel(model: string): Promise<FxConfigOption[]>;
  setMode(mode: string): Promise<FxConfigOption[]>;
  setConfigOption(id: string, value: string): Promise<FxConfigOption[]>;
  setConfig(config: Record<string, string>): Promise<FxConfigOption[]>;
  close(): Promise<void>;
  remove(): Promise<void>;
}

export interface FxAgent {
  readonly exited: Promise<number>;
  createSession(): Promise<FxSession>;
  openSession(id: string): Promise<FxSession>;
  listSessions(): Promise<{ id: string; updatedAtMs: number }[]>;
  close(): Promise<number>;
  abort(): void;
}

export interface FxWorkspaceExecRequest {
  command: string;
  cwd: string;
  signal: AbortSignal;
  timeoutMs: number;
  outputLimitBytes: number;
}

export interface FxWorkspaceExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface FxWorkspaceInfo {
  version: 1;
  root: string;
  cwd: string;
  home: string;
  /** Must be false: the sandbox has no git. */
  gitAvailable: false;
  /** Must be true: nothing survives the request. */
  ephemeral: true;
}

export interface FxWorkspaceAdapter {
  info: FxWorkspaceInfo;
  permission: "allow-sandboxed" | "prompt";
  exec(request: FxWorkspaceExecRequest): Promise<FxWorkspaceExecResult>;
}

/** A JSON Schema object schema, advertised to the model unchanged. */
export interface FxToolSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface FxHostToolContext {
  name: string;
  argumentsJson: string;
  signal: AbortSignal;
}

/** A tool the host implements. fx validates arguments before calling `handler`. */
export interface FxHostTool {
  name: string;
  description: string;
  parameters: FxToolSchema;
  /** Read-only tools skip the permission prompt. Defaults to true. */
  readOnly?: boolean;
  handler(
    args: Record<string, unknown>,
    context: FxHostToolContext,
  ): Promise<string | { output: string; isError?: boolean }> | string | { output: string; isError?: boolean };
}

export interface FxPermissionRequest {
  sessionId: string;
  toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
  options?: { optionId: string; name?: string; kind?: string }[];
  [key: string]: unknown;
}

export interface FxSessionStore {
  load(id: string): Promise<{ bytes: Uint8Array; revision: string } | null>;
  commit(
    id: string,
    bytes: Uint8Array,
    expectedRevision?: string,
  ): Promise<{ revision: string }>;
  list(): Promise<{ id: string; updatedAtMs: number }[]>;
  remove(id: string): Promise<void>;
}

export interface FxRuntimeEvent {
  type: string;
  timestamp: number;
  [key: string]: unknown;
}

export interface CreateFxAgentOptions {
  wasm: WebAssembly.Module | ArrayBuffer | Uint8Array | Response | string;
  env?: Record<string, string>;
  fetch?: typeof fetch;
  workspace?: FxWorkspaceAdapter;
  tools?: FxHostTool[];
  sessionStore?: FxSessionStore;
  configStore?: { get(id: string): Promise<string | null>; set(id: string, value: string): Promise<void> };
  onEvent?(event: FxRuntimeEvent): void;
  onPermission?(request: FxPermissionRequest): Promise<string | null> | string | null;
  stderr?(chunk: Uint8Array): void;
}

export function createFxAgent(options: CreateFxAgentOptions): Promise<FxAgent>;
export function supportsJspi(): boolean;
export const fxSdkApiVersion: number;
