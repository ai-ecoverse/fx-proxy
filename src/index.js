/**
 * fx-proxy on Cloudflare Workers: the JavaScript that remains.
 *
 * One module, one memory. `dist/worker.wasm` is the Hot Glue supervisor,
 * the i64 seam and Vercel's fx linked ahead of time by
 * scripts/link.mjs — the same step, and the same output shape, as the
 * Fastly build. What used to live here and no longer does: binding
 * fx-core's fifty-one imports, the trampolines that dropped their i64
 * arguments, a second instantiation, and the two byte-copies that
 * mediated between two memories. All of that was apparatus for an
 * arrangement that has gone away.
 *
 * What is left is the one thing this platform needs and Fastly does
 * not: **suspension**. Cloudflare's I/O is asynchronous and fx's agent
 * loop is not, so every capability below is a suspending import, and
 * fx's own entry is re-entered through WebAssembly.promising. Fastly's
 * hostcalls block, so its host layer is ordinary wasm in
 * src-hma/fastly.hma and there is no JavaScript at all.
 */
import workerModule from "../dist/worker.wasm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

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

/** Builds the request frame the supervisor parses (see frame.hma). */
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

      let inst;
      const mem = () => new Uint8Array(inst.exports.memory.buffer);

      let writer;
      let resolveStream;
      const streamStarted = new Promise((resolve) => (resolveStream = resolve));

      // one live streaming fetch per handle, for fx_http_stream_*
      const streams = new Map();
      let nextStream = 1;

      // --- the capabilities the wasm cannot have for itself -------------

      // buffered fetch: the proxy's own tools
      const hostFetch = async (ptr, len) => {
        const req = mem().slice(ptr, ptr + len);
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
        const dst = inst.exports.alloc(out.length);
        mem().set(out, dst);
        return dst;
      };

      // streaming fetch open: status into memory, a handle back
      const hostFetchOpen = async (ptr, len, statusOut) => {
        const req = mem().slice(ptr, ptr + len);
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
          new DataView(inst.exports.memory.buffer).setUint32(statusOut, response.status, true);
          return handle;
        } catch {
          new DataView(inst.exports.memory.buffer).setUint32(statusOut, 0, true);
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
        // dst is fx's buffer, which is this memory now: one copy, no mediation
        const n = Math.min(cap, state.leftover.length);
        mem().set(state.leftover.subarray(0, n), dst);
        state.leftover = state.leftover.subarray(n);
        return n;
      };

      const hostFetchClose = (handle) => {
        const state = streams.get(handle);
        if (state?.reader) state.reader.cancel().catch(() => {});
        streams.delete(handle);
      };

      const imports = {
        host: {
          fetch: new WebAssembly.Suspending(hostFetch),
          emit: new WebAssembly.Suspending(async (ptr, len) => {
            if (writer) await writer.write(mem().slice(ptr, ptr + len));
          }),
          log: (ptr, len) => console.log(decoder.decode(mem().slice(ptr, ptr + len))),
          stream_start: () => {
            const { readable, writable } = new TransformStream();
            writer = writable.getWriter();
            resolveStream(new Response(readable, { status: 200, headers: sseHeaders }));
          },
          fx_start: new WebAssembly.Suspending(() => fxStart()),
          sleep: new WebAssembly.Suspending((ms) => new Promise((r) => setTimeout(r, Math.min(ms, 2000)))),
          fetch_open: new WebAssembly.Suspending(hostFetchOpen),
          fetch_next: new WebAssembly.Suspending(hostFetchNext),
          fetch_close: hostFetchClose,
        },
        // The seam reaches for WASI's clock because Fastly has no hostcall
        // for one. Here the timestamp rides in on the request frame and
        // this is never called, but the import still has to be answered.
        wasi_snapshot_preview1: {
          clock_time_get: (_id, _precision, out) => {
            new DataView(inst.exports.memory.buffer).setBigUint64(out, BigInt(Date.now()) * 1000000n, true);
            return 0;
          },
        },
      };

      inst = await WebAssembly.instantiate(workerModule, imports);

      // fx is an export of this same module now. proc_exit throws to
      // unwind; treat that as a clean stop, exactly as before.
      const fxStartRaw = WebAssembly.promising(inst.exports.fx_core_start);
      const fxStart = () => fxStartRaw().then(() => 0, () => 0);

      // --- run ---------------------------------------------------------

      const reqBytes = requestFrame(request, body, env);
      const ptr = inst.exports.alloc(reqBytes.length);
      mem().set(reqBytes, ptr);

      const handled = WebAssembly.promising(inst.exports.handle)(ptr, reqBytes.length).then((respPtr) => {
        const bytes = mem();
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
