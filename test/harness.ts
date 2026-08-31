/**
 * Test harness for the worker, standing in for src/index.js.
 *
 * `callWorker` instantiates dist/worker.wasm — the supervisor, the i64
 * seam and fx-core, linked into one module with one memory — and drives
 * a full request; the model gateway is answered by a mock, so no network
 * and no real credentials are needed. fx speaks Vercel's AI-SDK
 * protocol, which an offline mock cannot fully satisfy, so gateway mocks
 * here return terminal statuses (e.g. 401).
 *
 * `callTool` drives one host tool directly through the worker's test
 * exports — without waking fx — to unit-test the search / fetch / kb
 * logic.
 */
import { readFileSync } from "node:fs";

const workerModule = new WebAssembly.Module(readFileSync(new URL("../dist/worker.wasm", import.meta.url)));
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export interface MockRequest {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface MockResponse {
  status: number;
  url?: string;
  contentType?: string;
  body?: string;
}

export interface CallOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  env?: Record<string, string>;
  fetchMock?: (req: MockRequest) => MockResponse;
  /**
   * Let the worker reach the real network instead of a mock. Used by the
   * live end-to-end test, which needs fx to actually complete a turn: fx
   * speaks Vercel's AI-SDK wire protocol, which no offline mock reproduces.
   */
  live?: boolean;
}

export interface WorkerResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  json?: unknown;
  sse: { event: string; data: any }[];
  streamed: boolean;
  fetches: MockRequest[];
}

function frame(parts: (number | Uint8Array)[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += typeof part === "number" ? 4 : 4 + part.length;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const part of parts) {
    if (typeof part === "number") {
      view.setUint32(at, part, true);
      at += 4;
    } else {
      view.setUint32(at, part.length, true);
      at += 4;
      out.set(part, at);
      at += part.length;
    }
  }
  return out;
}

function decodeFrame(req: Uint8Array): MockRequest & { payload: Uint8Array } {
  const view = new DataView(req.buffer, req.byteOffset, req.byteLength);
  let at = 0;
  const field = () => {
    const len = view.getUint32(at, true);
    const bytes = req.subarray(at + 4, at + 4 + len);
    at += 4 + len;
    return bytes;
  };
  const method = decoder.decode(field());
  const url = decoder.decode(field());
  const headers: Record<string, string> = {};
  let count = view.getUint32(at, true);
  at += 4;
  while (count-- > 0) headers[decoder.decode(field())] = decoder.decode(field());
  const payload = field().slice();
  return { method, url, headers, body: decoder.decode(payload), payload };
}

function requestFrame(options: CallOptions): Uint8Array {
  const head = frame([
    encoder.encode(options.method ?? "POST"),
    encoder.encode(options.url ?? "https://fx-proxy.test/v1/responses"),
  ]);
  const meta = new Uint8Array(20);
  new DataView(meta.buffer).setUint32(0, 1_700_000_000, true);
  for (let i = 4; i < 20; i++) meta[i] = i;
  const hp: (number | Uint8Array)[] = [];
  let hc = 0;
  for (const [k, v] of Object.entries(options.headers ?? {})) {
    hp.push(encoder.encode(k.toLowerCase()), encoder.encode(v));
    hc++;
  }
  const ep: (number | Uint8Array)[] = [];
  let ec = 0;
  for (const [k, v] of Object.entries(options.env ?? {})) {
    ep.push(encoder.encode(k), encoder.encode(v));
    ec++;
  }
  const tail = frame([hc, ...hp, ec, ...ep, encoder.encode(options.body ?? "")]);
  const all = new Uint8Array(head.length + meta.length + tail.length);
  all.set(head, 0);
  all.set(meta, head.length);
  all.set(tail, head.length + meta.length);
  return all;
}

export async function callWorker(options: CallOptions): Promise<WorkerResult> {
  const fetches: MockRequest[] = [];
  const sseRaw: string[] = [];
  let streamed = false;
  let worker: WebAssembly.Instance;
  const wmem = () => new Uint8Array((worker.exports.memory as WebAssembly.Memory).buffer);
  const streams = new Map<number, { data: Uint8Array; at: number }>();
  let nextStream = 1;

  const runMock = async (req: Uint8Array): Promise<MockResponse> => {
    const decoded = decodeFrame(req);
    const seen: MockRequest = { method: decoded.method, url: decoded.url, headers: decoded.headers, body: decoded.body };
    fetches.push(seen);
    if (options.live) {
      try {
        const response = await fetch(seen.url, {
          method: seen.method,
          headers: seen.headers,
          body: decoded.payload.length ? new Uint8Array(decoded.payload) as unknown as BodyInit : undefined,
          redirect: "follow",
        });
        return {
          status: response.status,
          url: response.url || "",
          contentType: response.headers.get("content-type") || "",
          body: await response.text(),
        };
      } catch (error) {
        return { status: 0, body: String((error as Error)?.message ?? error) };
      }
    }
    return options.fetchMock ? options.fetchMock(seen) : { status: 599, body: "no fetch mock" };
  };

  const hostFetch = async (ptr: number, len: number): Promise<number> => {
    const m = await runMock(wmem().slice(ptr, ptr + len));
    const out = frame([m.status, encoder.encode(m.url ?? ""), encoder.encode(m.contentType ?? ""), encoder.encode(m.body ?? "")]);
    const dst = (worker.exports.alloc as (n: number) => number)(out.length);
    wmem().set(out, dst);
    return dst;
  };
  const hostFetchOpen = async (ptr: number, len: number, statusOut: number): Promise<number> => {
    const m = await runMock(wmem().slice(ptr, ptr + len));
    const handle = nextStream++;
    streams.set(handle, { data: encoder.encode(m.body ?? ""), at: 0 });
    new DataView((worker.exports.memory as WebAssembly.Memory).buffer).setUint32(statusOut, m.status, true);
    return handle;
  };
  const hostFetchNext = async (handle: number, dst: number, cap: number): Promise<number> => {
    const s = streams.get(handle);
    if (!s) return -1;
    if (s.at >= s.data.length) return 0;
    // dst is fx's buffer, which is this memory now, as in the shim
    const n = Math.min(cap, s.data.length - s.at);
    wmem().set(s.data.subarray(s.at, s.at + n), dst);
    s.at += n;
    return n;
  };

  worker = await (WebAssembly.instantiate as any)(workerModule, {
    host: {
      fetch: new WebAssembly.Suspending(hostFetch),
      emit: new WebAssembly.Suspending(async (p: number, l: number) => {
        sseRaw.push(decoder.decode(wmem().slice(p, p + l)));
      }),
      log: () => {},
      stream_start: () => {
        streamed = true;
      },
      fx_start: new WebAssembly.Suspending(() => fxStart()),
      sleep: new WebAssembly.Suspending((ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 20)))),
      fetch_open: new WebAssembly.Suspending(hostFetchOpen),
      fetch_next: new WebAssembly.Suspending(hostFetchNext),
      fetch_close: () => {},
    },
    wasi_snapshot_preview1: {
      clock_time_get: (_id: number, _p: bigint, out: number) => {
        new DataView((worker.exports.memory as WebAssembly.Memory).buffer)
          .setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
        return 0;
      },
    },
  });

  const fxStartRaw = WebAssembly.promising(worker.exports.fx_core_start as () => number);
  const fxStart = () => fxStartRaw().then(() => 0, () => 0);

  const reqBytes = requestFrame(options);
  const ptr = (worker.exports.alloc as (n: number) => number)(reqBytes.length);
  wmem().set(reqBytes, ptr);
  const respPtr = await WebAssembly.promising(worker.exports.handle as (p: number, n: number) => number)(
    ptr,
    reqBytes.length,
  );

  const bytes = wmem();
  const view = new DataView(bytes.buffer);
  const status = view.getUint32(respPtr, true);
  let at = respPtr + 4;
  let count = view.getUint32(at, true);
  at += 4;
  const headers: Record<string, string> = {};
  const readField = () => {
    const len = view.getUint32(at, true);
    const b = bytes.subarray(at + 4, at + 4 + len);
    at += 4 + len;
    return b;
  };
  while (count-- > 0) headers[decoder.decode(readField())] = decoder.decode(readField());
  const body = decoder.decode(readField());
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }

  const sse: { event: string; data: any }[] = [];
  for (const block of sseRaw.join("").split("\n\n")) {
    if (!block.trim()) continue;
    const event = block.match(/^event: (.*)$/m)?.[1] ?? "";
    const data = block.match(/^data: (.*)$/m)?.[1];
    sse.push({ event, data: data ? JSON.parse(data) : undefined });
  }

  return { status, headers, body, json, sse, streamed, fetches };
}

// tool ids match $tool-id in agent.hma
export const TOOL = {
  web_search: 1,
  web_fetch: 2,
  knowledgebase_list: 3,
  knowledgebase_get: 4,
} as const;

export interface ToolResult {
  output: string;
  isError: boolean;
  fetches: MockRequest[];
}

/** Drives one host tool through the worker's test exports (no fx-core). */
export async function callTool(
  toolId: number,
  args: unknown,
  options: { env?: Record<string, string>; headers?: Record<string, string>; fetchMock?: (req: MockRequest) => MockResponse } = {},
): Promise<ToolResult> {
  const fetches: MockRequest[] = [];
  let worker: WebAssembly.Instance;
  const wmem = () => new Uint8Array((worker.exports.memory as WebAssembly.Memory).buffer);
  const streams = new Map<number, { data: Uint8Array; at: number }>();
  let nextStream = 1;

  const runMock = (req: Uint8Array): MockResponse => {
    const d = decodeFrame(req);
    fetches.push({ method: d.method, url: d.url, headers: d.headers, body: d.body });
    return options.fetchMock ? options.fetchMock({ method: d.method, url: d.url, headers: d.headers, body: d.body }) : { status: 599, body: "no mock" };
  };

  worker = await (WebAssembly.instantiate as any)(workerModule, {
    host: {
      fetch: new WebAssembly.Suspending(async (ptr: number, len: number) => {
        const m = await runMock(wmem().slice(ptr, ptr + len));
        const out = frame([m.status, encoder.encode(m.url ?? ""), encoder.encode(m.contentType ?? ""), encoder.encode(m.body ?? "")]);
        const dst = (worker.exports.alloc as (n: number) => number)(out.length);
        wmem().set(out, dst);
        return dst;
      }),
      emit: new WebAssembly.Suspending(async () => {}),
      log: () => {},
      stream_start: () => {},
      fx_start: new WebAssembly.Suspending(async () => 0),
      sleep: new WebAssembly.Suspending(async () => {}),
      fetch_open: new WebAssembly.Suspending(async (ptr: number, len: number, statusOut: number) => {
        const m = await runMock(wmem().slice(ptr, ptr + len));
        const handle = nextStream++;
        streams.set(handle, { data: encoder.encode(m.body ?? ""), at: 0 });
        new DataView((worker.exports.memory as WebAssembly.Memory).buffer).setUint32(statusOut, m.status, true);
        return handle;
      }),
      // no fx-core here, so the stream gates are unreachable
      fetch_next: new WebAssembly.Suspending(async () => -1),
      fetch_close: () => {},
    },
    wasi_snapshot_preview1: {
      clock_time_get: (_id: number, _p: bigint, out: number) => {
        new DataView((worker.exports.memory as WebAssembly.Memory).buffer)
          .setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
        return 0;
      },
    },
  });
  const ex = worker.exports as any;

  // seed request-scoped config
  const reqBytes = requestFrame({ env: options.env, headers: options.headers, body: "{}" });
  const rptr = ex.alloc(reqBytes.length);
  wmem().set(reqBytes, rptr);
  ex.t_config(rptr, reqBytes.length);

  const argJson = encoder.encode(JSON.stringify(args));
  const aptr = ex.alloc(argJson.length);
  wmem().set(argJson, aptr);
  const cell = await WebAssembly.promising(ex.t_tool)(toolId, aptr, argJson.length);
  const output = decoder.decode(wmem().slice(ex.t_cell0(cell), ex.t_cell0(cell) + ex.t_cell1(cell)));
  return { output, isError: ex.t_tool_err() !== 0, fetches };
}
