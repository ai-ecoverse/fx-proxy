export interface ResponsesRequestBody {
  model?: unknown;
  input?: unknown;
  instructions?: unknown;
  stream?: unknown;
  metadata?: unknown;
  include?: unknown;
  max_output_tokens?: unknown;
  previous_response_id?: unknown;
  tools?: unknown;
  store?: unknown;
  [key: string]: unknown;
}

export interface OutputTextContent {
  type: "output_text";
  text: string;
  annotations: unknown[];
}

export interface MessageItem {
  id: string;
  type: "message";
  status: "in_progress" | "completed";
  role: "assistant";
  content: OutputTextContent[];
}

export interface ReasoningItem {
  id: string;
  type: "reasoning";
  status: "in_progress" | "completed";
  summary: { type: "summary_text"; text: string }[];
}

export type WebSearchAction =
  | { type: "search"; query: string }
  | { type: "open_page"; url: string };

export interface WebSearchCallItem {
  id: string;
  type: "web_search_call";
  status: "in_progress" | "searching" | "completed" | "failed";
  action: WebSearchAction;
}

export interface CustomToolCallItem {
  id: string;
  type: "custom_tool_call";
  status: "in_progress" | "completed" | "failed";
  call_id: string;
  name: "terminal";
  input: string;
  output?: string;
}

export type OutputItem =
  | MessageItem
  | ReasoningItem
  | WebSearchCallItem
  | CustomToolCallItem;

export interface Usage {
  input_tokens: number;
  input_tokens_details: { cached_tokens: number };
  output_tokens: number;
  output_tokens_details: { reasoning_tokens: number };
  total_tokens: number;
}

export interface ResponseObject {
  id: string;
  object: "response";
  created_at: number;
  status: "in_progress" | "completed" | "incomplete" | "failed" | "cancelled";
  background: false;
  error: { code: string; message: string } | null;
  incomplete_details: { reason: string } | null;
  instructions: string | null;
  max_output_tokens: number | null;
  metadata: Record<string, string>;
  model: string;
  output: OutputItem[];
  output_text?: string;
  parallel_tool_calls: false;
  previous_response_id: string | null;
  store: false;
  temperature: null;
  tool_choice: "auto";
  tools: { type: string }[];
  top_p: null;
  truncation: "disabled";
  usage: Usage;
  user: null;
  /** Proxy-specific detail; not part of the OpenAI schema. */
  fx: {
    stop_reason: string;
    model_requests: number;
    tool_calls: number;
    agent: "fx";
    runtime: string;
  };
}

export interface StreamEvent {
  type: string;
  sequence_number: number;
  [key: string]: unknown;
}
