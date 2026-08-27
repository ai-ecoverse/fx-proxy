# fx-proxy

An OpenAI **Responses API** endpoint in front of Vercel Labs' **fx** coding
agent, with the entire host layer — the part that used to be JavaScript —
written in [Hot Glue](https://github.com/ai-ecoverse/hot-glue), the macro
assembler for WebAssembly, written in WebAssembly, operating on WebAssembly.

Two wasm modules run side by side:

- **`vendor/fx-core.wasm`** — Vercel's fx agent, unmodified (2.6 MB of
  compiled Zig). It owns the agent loop, prompting, tool-argument validation
  and the model conversation.
- **`dist/worker.wasm`** (~56 KB) — the Hot Glue supervisor, compiled from the
  `.hma` sources in `src-hma/`. It serves fx-core's 51 imports, routes and
  validates requests, drives fx over ACP, implements the host tools, and
  assembles the Responses output and SSE stream.

The only JavaScript deployed is `src/index.js`, a ~250-line shim that moves
bytes: it holds the two instances' memories, mediates the cross-instance
copies, and owns the single suspending capability, `fetch`.

```
client ──POST /v1/responses──▶ src/index.js (byte-moving shim)
                                 │  one request frame in, one frame out
                                 ▼
                               dist/worker.wasm  (Hot Glue supervisor)
                                 ├─ router, validation, credentials
                                 ├─ serves fx-core's 51 imports (gates.hma)
                                 ├─ ACP driver (acp.hma) ──▶ fx-core.wasm ──▶ Vercel AI Gateway
                                 ├─ host tools: web_search / web_fetch
                                 │              knowledgebase_list / knowledgebase_get
                                 └─ Responses object or SSE events ──▶ client
```

A client sends a plain, tool-free request. The supervisor drives fx-core
through the Agent Client Protocol (`initialize` → `session/new` →
`session/prompt`); fx runs its agent loop against the model with the
supervisor's host tools (web search, page fetch, an optional AEM knowledge
base), and its streamed `session/update` chunks are assembled into a single
Responses object — or a Responses-shaped SSE stream.

Status: experimental. Deployed at `https://fx-proxy.minivelos.workers.dev`
(Cloudflare account *AEM Demo*).

## How fx is embedded, not reimplemented

This follows Hot Glue's `tools/emscripten-gates` doctrine: read the foreign
binary's JS glue as a specification and re-serve its import surface from a
pure-wasm host. fx-core imports 51 functions (WASI plus an `fx` namespace for
HTTP, host tools, sessions, config). The supervisor exports a matching
`g_<name>` gate for each; the shim wires them with one generic loop and a
handful of trampolines that drop fx's i64 arguments (every one is unused or
stubbed), so no i64 crosses into the assembler.

The two instances keep separate memories. The supervisor never imports
fx-core; instead the shim holds both memories and mediates the two
cross-instance copies (`gread` / `gwrite`), and runs fx's promising `_start`
through a suspending `fx_start` import. That means **no multi-memory** is
needed in the wasm.

The supervisor imports these host functions:

| Import | Role |
| --- | --- |
| `host.fetch` | Buffered request (the proxy's own tools). Suspending. |
| `host.fetch_open` / `fetch_next` / `fetch_close` | Streaming HTTP for fx's model calls, so large responses never fully buffer. Suspending. |
| `host.fx_start` | Runs `WebAssembly.promising(fx._start)`. Suspending. |
| `host.gread` / `host.gwrite` | Copy bytes between the two instances' memories. |
| `host.emit` | One SSE chunk out. Suspending. |
| `host.stream_start` | Flips the reply into a `text/event-stream`. |
| `host.sleep` / `host.log` | Timed wait for fx's poll; debug output. |

Cloudflare's runtime supports WebAssembly JSPI (`WebAssembly.Suspending` /
`WebAssembly.promising`), so fx's synchronous agent loop suspends all the way
down — `fx_start → a gate → fetch_open` — while JavaScript awaits the network.
Time, randomness, headers and environment arrive in the request frame.

An earlier iteration reimplemented fx's loop directly in Hot Glue for a single
self-contained binary; embedding the real fx-core recovers fx's own agent
behaviour, prompting, schema-enforced tool arguments, and token-level
streaming. The request and response wire format is unchanged.

## Build

```sh
npm install
npm run build        # src-hma/*.hma -> dist/worker.wasm
npm test             # 35 tests drive the wasm with a mocked host
npm run dev          # wrangler dev
npm run deploy
```

The toolchain is vendored under `hotglue/` and runs offline:

1. **Stage 0** — `hotglue/bootstrap.ts` (Hot Glue's bootstrap
   reader/expander/lowerer, run via Node's native type-stripping) expands
   `src-hma/worker.hma` and its `(use …)` layers to WAT.
2. **Self-hosted assembly** — `hotglue/as.wasm`, the Hot Glue assembler that
   assembles its own source, turns that WAT into `dist/worker.wasm` under
   `node:wasi`.

No external assembler, no Binaryen, no network. The vendored toolchain is
stock upstream Hot Glue, pinned at
[`ca30cad`](https://github.com/ai-ecoverse/hot-glue/commit/ca30cad); nothing
here is patched. Three changes this project needed went upstream first:

- [#7](https://github.com/ai-ecoverse/hot-glue/pull/7) resolves `(use …)` at
  any depth, which is what lets a `(module …)` be composed from files of
  functions — the shape of `src-hma/`.
- [#5](https://github.com/ai-ecoverse/hot-glue/pull/5) memoizes the stage-0
  printer, which was quadratic in depth; this module took minutes to print.
- [#6](https://github.com/ai-ecoverse/hot-glue/pull/6) makes the assembler
  refuse a non-i32 valtype in an implicit signature instead of silently
  assembling the wrong one.

Because of that last one, fx-core's i64-bearing imports cannot be served by
implicitly typed gates. The shim's trampolines drop those arguments (every one
is unused or stubbed) so every gate is pure i32; `docs/runtime-notes.md`
records why.

## The Hot Glue sources

| File | Owns |
| --- | --- |
| `src-hma/worker.hma` | module shell, imports, request frame intake, config, credentials, router, request validation |
| `src-hma/slots.hma` | the request-scoped register map (macros only) |
| `src-hma/rt.hma` | bump allocator, growable buffers, string ops |
| `src-hma/json.hma` | cursor JSON: span navigation, string decode (incl. `\uXXXX` surrogates), escaping writer |
| `src-hma/text.hma` | entity decoding, tag stripping, readable-text extraction, truncation |
| `src-hma/url.hma` | URL parsing, private-host refusals, percent/form encoding |
| `src-hma/frame.hma` | the length-prefixed byte protocol with the shim |
| `src-hma/gates.hma` | fx-core's 51 imports, served from this module |
| `src-hma/acp.hma` | the ACP driver: the JSON-RPC state machine that drives fx |
| `src-hma/manifest.hma` | the fx host-tools manifest, environ vector, and the fx run |
| `src-hma/search.hma` | all eight search providers |
| `src-hma/kb.hma` | AEM knowledge base: sitemap walk, query-index merge, markdown retrieval |
| `src-hma/agent.hma` | host tools: `web_fetch`, argument access, tool dispatch |
| `src-hma/assemble.hma` | Responses output items, SSE events, the final response object |

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/responses` | Responses API. `stream: true` emits SSE. |
| `GET` | `/v1/models` | The configured default model. |
| `GET` | `/health` | Service and configuration summary. |

Supported request fields: `model`, `input` (string or message array),
`instructions`, `stream`, `metadata`, `include`, `max_output_tokens`.

`include: ["fx.debug"]` logs each gateway round-trip and every tool call.

Output items mirror OpenAI's built-in web search: each `web_search` call
appears as a `web_search_call` item with a `search` action, each `web_fetch`
as one with an `open_page` action, followed by the assistant `message`. A
non-standard `fx` block reports the stop reason, model request count and tool
call count. `usage` is real: token counts are summed from the gateway
responses.

```bash
curl -sS https://fx-proxy.minivelos.workers.dev/v1/responses \
  -H "authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"input":"What changed in Zig 0.16? Cite sources."}' | jq -r .output_text
```

Any OpenAI SDK works by pointing `base_url` at the deployment.

## Tool surface

| Tool | Arguments | When |
| --- | --- | --- |
| `web_search` | `query` (required), `count`, `site`, `freshness: day\|week\|month\|year` | always |
| `web_fetch` | `url` (required), `max_chars` | always |
| `knowledgebase_list` | `prefix`, `query`, `limit` | with kb headers |
| `knowledgebase_get` | `path` (required), `max_chars` | with kb headers |

Search providers (`SEARCH_PROVIDER`): `ddg` (keyless), `brave`, `tavily`,
`exa`, `serper` (need `SEARCH_API_KEY`), and `perplexity`, `parallel`, `tako`
(Vercel AI Gateway server tools, billed through the request's gateway key).

An AEM knowledge base binds per request via headers: `x-org`/`x-owner`/
`x-aem-org` and `x-repo`/`x-site`/`x-aem-repo` (plus optional `x-ref`), which
resolve to `https://<ref>--<repo>--<org>.aem.live`.

`web_fetch` refuses private and loopback hosts (localhost, RFC 1918 ranges,
link-local metadata endpoints, `.internal`/`.local`).

## Credentials

With `PROXY_API_KEY` set, the proxy authenticates callers and uses its own
`AI_GATEWAY_API_KEY`. Without it, the caller's bearer token is forwarded to
the gateway and the proxy stores no credentials.
