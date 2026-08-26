/**
 * fx-proxy, the JavaScript that remains.
 *
 * The worker is dist/worker.wasm — a single Hot Glue module compiled
 * from src-hma/ that owns routing, request parsing, the agent loop,
 * every tool, and the Responses API assembly. This shim only moves
 * bytes across the boundary:
 *
 *   request  -> one length-prefixed frame in wasm memory
 *   host.fetch  <- suspending import (WebAssembly JSPI); the wasm's
 *                  only capability, used for gateway and tool traffic
 *   host.emit   <- SSE chunks when the wasm streams
 *   host.stream_start <- flips the reply to an event stream
 *   response <- one frame back, or the stream
 */
import wasmModule from "../dist/worker.wasm";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const sseHeaders = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
  "access-control-allow-origin": "*",
};

/** Length-prefixed field writer: [u32 len][bytes]. */
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

export default {
  async fetch(request, env) {
    try {
      const body = new Uint8Array(await request.arrayBuffer());
      let instance;
      const mem = () => new Uint8Array(instance.exports.memory.buffer);

      let writer;
      let resolveStream;
      const streamStarted = new Promise((resolve) => (resolveStream = resolve));

      const hostFetch = async (ptr, len) => {
        const req = mem().slice(ptr, ptr + len);
        const view = new DataView(req.buffer);
        let at = 0;
        let method, url, header;
        [method, at] = readField(view, req, at);
        [url, at] = readField(view, req, at);
        const headers = {};
        let count = view.getUint32(at, true);
        at += 4;
        while (count-- > 0) {
          let name, value;
          [name, at] = readField(view, req, at);
          [value, at] = readField(view, req, at);
          headers[decoder.decode(name)] = decoder.decode(value);
        }
        let payload;
        [payload, at] = readField(view, req, at);
        let status = 0;
        let finalUrl = "";
        let contentType = "";
        let respBody = new Uint8Array(0);
        try {
          const response = await fetch(decoder.decode(url), {
            method: decoder.decode(method),
            headers,
            body: payload.length ? payload.slice() : undefined,
            redirect: "follow",
          });
          status = response.status;
          finalUrl = response.url || "";
          contentType = response.headers.get("content-type") || "";
          respBody = new Uint8Array(await response.arrayBuffer());
        } catch (error) {
          respBody = encoder.encode(String((error && error.message) || error));
        }
        const out = frame([
          status,
          encoder.encode(finalUrl),
          encoder.encode(contentType),
          respBody,
        ]);
        const dst = instance.exports.alloc(out.length);
        mem().set(out, dst);
        return dst;
      };

      instance = new WebAssembly.Instance(wasmModule, {
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
        },
      });

      const parts = [encoder.encode(request.method), encoder.encode(new URL(request.url).toString())];
      const requestFrame = frame(parts);
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
      const full = frame([
        ...parts.flatMap((p) => [p]),
        // meta is raw, not length-prefixed; splice it manually below
      ]);
      // assemble: method, url, meta(20 raw), nheaders, pairs, nenv, pairs, body
      const tail = frame([headerCount, ...headerParts, envCount, ...envParts, body]);
      const all = new Uint8Array(full.length + meta.length + tail.length);
      all.set(full, 0);
      all.set(meta, full.length);
      all.set(tail, full.length + meta.length);

      const ptr = instance.exports.alloc(all.length);
      mem().set(all, ptr);

      const handled = WebAssembly.promising(instance.exports.handle)(ptr, all.length).then(
        (respPtr) => {
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
        },
      );

      const outcome = await Promise.race([handled, streamStarted]);
      if (outcome instanceof Response) {
        handled
          .catch(() => {})
          .then(() => writer && writer.close().catch(() => {}));
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
