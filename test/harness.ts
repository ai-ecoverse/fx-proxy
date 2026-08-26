/**
 * Test harness for dist/worker.wasm.
 *
 * The shim's imports are replaced with synchronous mocks, so `handle`
 * runs without JSPI: outbound requests are answered by a fetch mock,
 * SSE chunks are collected, and the response frame is decoded back.
 */
import { readFileSync } from "node:fs";

const wasmBytes = readFileSync(new URL("../dist/worker.wasm", import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
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

export interface WorkerResult {
  status: number;
  headers: Record<string, string>;
  body: string;
  json?: unknown;
  sse: { event: string; data: any }[];
  streamed: boolean;
  fetches: MockRequest[];
}

export interface CallOptions {
  method?: string;
  url?: string;
  headers?: Record<string, string>;
  body?: string;
  env?: Record<string, string>;
  fetchMock?: (req: MockRequest) => MockResponse;
  now?: number;
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

function readField(bytes: Uint8Array, at: number): [Uint8Array, number] {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const len = view.getUint32(at, true);
  return [bytes.subarray(at + 4, at + 4 + len), at + 4 + len];
}

export function callWorker(options: CallOptions): WorkerResult {
  const fetches: MockRequest[] = [];
  const sseRaw: Uint8Array[] = [];
  let streamed = false;
  let instance: WebAssembly.Instance;
  const mem = () => new Uint8Array((instance.exports.memory as WebAssembly.Memory).buffer);

  const hostFetch = (ptr: number, len: number): number => {
    const req = mem().slice(ptr, ptr + len);
    let at = 0;
    let method: Uint8Array, url: Uint8Array;
    [method, at] = readField(req, at);
    [url, at] = readField(req, at);
    const headers: Record<string, string> = {};
    let count = new DataView(req.buffer).getUint32(at, true);
    at += 4;
    while (count-- > 0) {
      let name: Uint8Array, value: Uint8Array;
      [name, at] = readField(req, at);
      [value, at] = readField(req, at);
      headers[decoder.decode(name)] = decoder.decode(value);
    }
    let payload: Uint8Array;
    [payload, at] = readField(req, at);
    const mockReq: MockRequest = {
      method: decoder.decode(method),
      url: decoder.decode(url),
      headers,
      body: decoder.decode(payload),
    };
    fetches.push(mockReq);
    const mocked = options.fetchMock
      ? options.fetchMock(mockReq)
      : { status: 599, body: "no fetch mock installed" };
    const out = frame([
      mocked.status,
      encoder.encode(mocked.url ?? ""),
      encoder.encode(mocked.contentType ?? ""),
      encoder.encode(mocked.body ?? ""),
    ]);
    const dst = (instance.exports.alloc as (n: number) => number)(out.length);
    mem().set(out, dst);
    return dst;
  };

  instance = new WebAssembly.Instance(wasmModule, {
    host: {
      fetch: hostFetch,
      emit: (ptr: number, len: number) => {
        sseRaw.push(mem().slice(ptr, ptr + len));
      },
      log: () => {},
      stream_start: () => {
        streamed = true;
      },
    },
  });

  const headerParts: (number | Uint8Array)[] = [];
  let headerCount = 0;
  for (const [name, value] of Object.entries(options.headers ?? {})) {
    headerParts.push(encoder.encode(name.toLowerCase()), encoder.encode(value));
    headerCount++;
  }
  const envParts: (number | Uint8Array)[] = [];
  let envCount = 0;
  for (const [name, value] of Object.entries(options.env ?? {})) {
    envParts.push(encoder.encode(name), encoder.encode(value));
    envCount++;
  }
  const head = frame([
    encoder.encode(options.method ?? "POST"),
    encoder.encode(options.url ?? "https://fx-proxy.test/v1/responses"),
  ]);
  const meta = new Uint8Array(20);
  new DataView(meta.buffer).setUint32(0, options.now ?? 1_700_000_000, true);
  for (let i = 4; i < 20; i++) meta[i] = i;
  const tail = frame([
    headerCount,
    ...headerParts,
    envCount,
    ...envParts,
    encoder.encode(options.body ?? ""),
  ]);
  const all = new Uint8Array(head.length + meta.length + tail.length);
  all.set(head, 0);
  all.set(meta, head.length);
  all.set(tail, head.length + meta.length);

  const ptr = (instance.exports.alloc as (n: number) => number)(all.length);
  mem().set(all, ptr);
  const respPtr = (instance.exports.handle as (p: number, n: number) => number)(ptr, all.length);

  const bytes = mem();
  const view = new DataView(bytes.buffer);
  const status = view.getUint32(respPtr, true);
  let at = respPtr + 4;
  let count = view.getUint32(at, true);
  at += 4;
  const headers: Record<string, string> = {};
  while (count-- > 0) {
    let name: Uint8Array, value: Uint8Array;
    [name, at] = readField(bytes, at);
    [value, at] = readField(bytes, at);
    headers[decoder.decode(name)] = decoder.decode(value);
  }
  let payload: Uint8Array;
  [payload, at] = readField(bytes, at);
  const body = decoder.decode(payload);
  let json: unknown;
  try {
    json = JSON.parse(body);
  } catch {
    json = undefined;
  }

  const sse: { event: string; data: any }[] = [];
  const sseText = sseRaw.map((chunk) => decoder.decode(chunk)).join("");
  for (const block of sseText.split("\n\n")) {
    if (!block.trim()) continue;
    const event = block.match(/^event: (.*)$/m)?.[1] ?? "";
    const data = block.match(/^data: (.*)$/m)?.[1];
    sse.push({ event, data: data ? JSON.parse(data) : undefined });
  }

  return { status, headers, body, json, sse, streamed, fetches };
}
