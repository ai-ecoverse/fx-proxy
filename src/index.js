/**
 * fx-proxy, the JavaScript that remains.
 *
 * Two wasm modules run side by side and the shim only moves bytes:
 *
 *   dist/worker.wasm  — the Hot Glue supervisor. Routing, request
 *     parsing, the ACP driver, every host tool, the Responses assembly.
 *     Exports `handle`, `alloc`, `memory`, and the 51 `g_*` gates.
 *   vendor/fx-core.wasm — Vercel's fx agent, unmodified. Its 51 imports
 *     are wired to the supervisor's gates through generic trampolines
 *     that drop fx's i64 arguments (every one is unused or stubbed).
 *
 * The supervisor never imports fx directly; the host mediates the two
 * cross-instance byte copies (gread/gwrite) and runs fx's promising
 * `_start`, so no multi-memory is needed. JSPI (WebAssembly.Suspending /
 * .promising) lets the synchronous wasm agent loop drive async I/O.
 */
import workerModule from "../dist/worker.wasm";
import fxCoreModule from "../vendor/fx-core.wasm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

// fx-core's imports and the i32-argument positions the trampolines keep.
// Anything not listed is passed through unchanged (all-i32).
const FX_IMPORTS = {
  // name: [indices of i32 args to forward to the g_* gate]
  clock_time_get: [0, 2], // drop the i64 precision
  fd_seek: [0, 2, 3], // drop the i64 offset
  fd_filestat_set_size: [0],
  fd_filestat_set_times: [0, 3],
  fd_pread: [0, 1, 2, 4],
  fd_pwrite: [0, 1, 2, 4],
  fd_readdir: [0, 1, 2, 4],
  path_filestat_set_times: [0, 1, 2, 3, 6],
  path_open: [0, 1, 2, 3, 4, 7, 8],
};

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "access-control-allow-origin": "*",
};

function frame(parts) {
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

function readField(view, bytes, at) {
  const len = view.getUint32(at, true);
  return [bytes.subarray(at + 4, at + 4 + len), at + 4 + len];
}

/** Builds the request frame the supervisor parses. */
function requestFrame(request, body, env) {
  const head = frame([encoder.encode(request.method), encoder.encode(new URL(request.url).toString())]);
  const meta = new Uint8Array(20);
  new DataView(meta.buffer).setUint32(0, Math.floor(Date.now() / 1000), true);
  crypto.getRandomValues(meta.subarray(4));
  const headerParts = [];
  let headerCount = 0;
  for (const [name, value] of request.headers) {
    headerParts.push(encoder.encode(name), encoder.encode(value));
    headerCount++;
  }
  const envParts = [];
  let envCount = 0;
  for (const [name, value] of Object.entries(env ?? {})) {
    if (typeof value !== "string") continue;
    envParts.push(encoder.encode(name), encoder.encode(value));
    envCount++;
  }
  const tail = frame([headerCount, ...headerParts, envCount, ...envParts, body]);
  const all = new Uint8Array(head.length + meta.length + tail.length);
  all.set(head, 0);
  all.set(meta, head.length);
  all.set(tail, head.length + meta.length);
  return all;
}

export default {
  async fetch(request, env) {
    try {
      const body = new Uint8Array(await request.arrayBuffer());

      let worker;
      let fxCore;
      const wmem = () => new Uint8Array(worker.exports.memory.buffer);
      const fmem = () => new Uint8Array(fxCore.exports.memory.buffer);

      let writer;
      let resolveStream;
      const streamStarted = new Promise((resolve) => (resolveStream = resolve));

      // one live streaming fetch per handle, for fx_http_stream_*
      const streams = new Map();
      let nextStream = 1;

      // --- host functions the supervisor imports -----------------------

      // buffered fetch: used by the proxy's own tools (search/kb/web_fetch)
      const hostFetch = async (ptr, len) => {
        const req = wmem().slice(ptr, ptr + len);
        const { method, url, headers, payload } = decodeFrameLocal(req);
        let status = 0;
        let finalUrl = "";
        let contentType = "";
        let respBody = new Uint8Array(0);
        try {
          const response = await fetch(url, {
            method,
            headers,
            body: payload.length ? payload : undefined,
            redirect: "follow",
          });
          status = response.status;
          finalUrl = response.url || "";
          contentType = response.headers.get("content-type") || "";
          respBody = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          respBody = encoder.encode(String((error && error.message) || error));
        }
        const out = frame([status, encoder.encode(finalUrl), encoder.encode(contentType), respBody]);
        const dst = worker.exports.alloc(out.length);
        wmem().set(out, dst);
        return dst;
      };

      // streaming fetch open: status written into the supervisor's memory,
      // a handle returned (0 on transport failure)
      const hostFetchOpen = async (ptr, len, statusOut) => {
        const req = wmem().slice(ptr, ptr + len);
        const { method, url, headers, payload } = decodeFrameLocal(req);
        try {
          const response = await fetch(url, {
            method,
            headers,
            body: payload.length ? payload : undefined,
            redirect: "follow",
          });
          const handle = nextStream++;
          streams.set(handle, { reader: response.body?.getReader() ?? null, leftover: new Uint8Array() });
          new DataView(worker.exports.memory.buffer).setUint32(statusOut, response.status, true);
          return handle;
        } catch {
          new DataView(worker.exports.memory.buffer).setUint32(statusOut, 0, true);
          return 0;
        }
      };

      const hostFetchNext = async (handle, dst, cap) => {
        const state = streams.get(handle);
        if (!state) return -1;
        if (!state.leftover.length) {
          if (!state.reader) return 0;
          const { done, value } = await state.reader.read();
          if (done) return 0;
          state.leftover = value ?? new Uint8Array();
          if (!state.leftover.length) return 0;
        }
        const n = Math.min(cap, state.leftover.length);
        wmem().set(state.leftover.subarray(0, n), dst);
        state.leftover = state.leftover.subarray(n);
        return n;
      };

      const hostFetchClose = (handle) => {
        const state = streams.get(handle);
        if (state?.reader) state.reader.cancel().catch(() => {});
        streams.delete(handle);
      };

      const workerImports = {
        host: {
          fetch: new WebAssembly.Suspending(hostFetch),
          emit: new WebAssembly.Suspending(async (ptr, len) => {
            if (writer) await writer.write(wmem().slice(ptr, ptr + len));
          }),
          log: (ptr, len) => console.log(decoder.decode(wmem().slice(ptr, ptr + len))),
          stream_start: () => {
            const { readable, writable } = new TransformStream();
            writer = writable.getWriter();
            resolveStream(new Response(readable, { status: 200, headers: sseHeaders }));
          },
          // cross-instance byte copies: the host holds both memories
          gread: (fxPtr, len, dst) => wmem().set(fmem().subarray(fxPtr, fxPtr + len), dst),
          gwrite: (src, len, fxPtr) => fmem().set(wmem().subarray(src, src + len), fxPtr),
          fx_start: new WebAssembly.Suspending(() => fxStart()),
          sleep: new WebAssembly.Suspending((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2000)))),
          fetch_open: new WebAssembly.Suspending(hostFetchOpen),
          fetch_next: new WebAssembly.Suspending(hostFetchNext),
          fetch_close: hostFetchClose,
        },
      };

      worker = await WebAssembly.instantiate(workerModule, workerImports);

      // --- fx-core, wired to the supervisor's gates --------------------

      const fxImports = { wasi_snapshot_preview1: {}, fx: {} };
      const bindGate = (name) => {
        const gate = worker.exports["g_" + name];
        const keep = FX_IMPORTS[name];
        if (!keep) return gate; // all-i32: forward unchanged
        return (...args) => gate(...keep.map((i) => args[i]));
      };
      // fx-core's imports are in two namespaces; the export name is the
      // bare function name in both cases.
      for (const imp of WebAssembly.Module.imports(fxCoreModule)) {
        if (imp.kind !== "function") continue;
        const ns = imp.module === "fx" ? fxImports.fx : fxImports.wasi_snapshot_preview1;
        ns[imp.name] = bindGate(imp.name);
      }

      fxCore = await WebAssembly.instantiate(fxCoreModule, fxImports);
      const fxStartRaw = WebAssembly.promising(fxCore.exports._start);
      // proc_exit throws to unwind; treat that as a clean stop
      const fxStart = () => fxStartRaw().then(() => 0, () => 0);

      // --- run ---------------------------------------------------------

      const reqBytes = requestFrame(request, body, env);
      const ptr = worker.exports.alloc(reqBytes.length);
      wmem().set(reqBytes, ptr);

      const handled = WebAssembly.promising(worker.exports.handle)(ptr, reqBytes.length).then((respPtr) => {
        const bytes = wmem();
        const view = new DataView(bytes.buffer);
        const status = view.getUint32(respPtr, true);
        let at = respPtr + 4;
        let count = view.getUint32(at, true);
        at += 4;
        const headers = new Headers();
        while (count-- > 0) {
          let name, value;
          [name, at] = readField(view, bytes, at);
          [value, at] = readField(view, bytes, at);
          headers.append(decoder.decode(name), decoder.decode(value));
        }
        let payload;
        [payload, at] = readField(view, bytes, at);
        return { status, headers, payload: payload.slice() };
      });

      const outcome = await Promise.race([handled, streamStarted]);
      if (outcome instanceof Response) {
        handled.catch(() => {}).then(() => writer && writer.close().catch(() => {}));
        return outcome;
      }
      return new Response(outcome.status === 204 ? null : outcome.payload, {
        status: outcome.status,
        headers: outcome.headers,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        JSON.stringify({ error: { message, type: "server_error", param: null, code: null } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
  },
};

/** Frame layout: [u32 mlen][method][u32 ulen][url][u32 nh]{k,v}*[u32 blen][body]. */
function decodeFrameLocal(req) {
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
  const headers = {};
  let count = view.getUint32(at, true);
  at += 4;
  while (count-- > 0) {
    const name = decoder.decode(field());
    const value = decoder.decode(field());
    headers[name] = value;
  }
  const payload = field().slice();
  return { method, url, headers, payload };
}
