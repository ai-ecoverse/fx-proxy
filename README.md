# fx-proxy

An OpenAI **Responses API** agent endpoint, compiled to a **single,
self-contained WebAssembly binary** written in
[Hot Glue](https://github.com/ai-ecoverse/hot-glue) — the macro assembler for
WebAssembly, written in WebAssembly, operating on WebAssembly.

The worker is `dist/worker.wasm` (~50 KB): routing, request validation, the
agent loop, the tool implementations, JSON parsing and serialization, HTML
text extraction, SSE streaming — all of it lives in one wasm module compiled
from the `.hma` sources in `src-hma/`. The only JavaScript deployed is
`src/index.js`, a ~200-line shim that moves bytes across the module boundary
and owns exactly one capability: `fetch`.

```
client ──POST /v1/responses──▶ src/index.js (byte-moving shim)
                                 │  one request frame in, one frame out
                                 ▼
                               dist/worker.wasm  (Hot Glue)
                                 ├─ router, validation, credentials
                                 ├─ agent loop ── chat completions ─▶ Vercel AI Gateway
                                 ├─ web_search / web_fetch
                                 ├─ knowledgebase_list / knowledgebase_get
                                 └─ Responses object or SSE events ──▶ client
```

A client sends a plain, tool-free request. Inside the wasm, an agent loop runs
against the underlying model with a host-advertised tool surface (web search,
page fetch, and an optional AEM knowledge base), iterates until the question
is settled, and returns the finished answer as a single Responses object — or
as a Responses-shaped SSE stream.

Status: experimental. Deployed at `https://fx-proxy.minivelos.workers.dev`
(Cloudflare account *AEM Demo*).

## Why this works

The wasm imports exactly four host functions:

| Import | Role |
| --- | --- |
| `host.fetch` | The single capability. Wrapped in `WebAssembly.Suspending`, so the wasm calls it *synchronously* and the JSPI runtime suspends the instance while JavaScript awaits the network. |
| `host.emit` | One SSE chunk out (suspending, for backpressure). |
| `host.stream_start` | Flips the reply into a `text/event-stream`. |
| `host.log` | Debug lines to `console.log`. |

Cloudflare's runtime supports WebAssembly JSPI (`WebAssembly.Suspending` /
`WebAssembly.promising`), which is what lets a synchronous wasm agent loop
drive asynchronous network I/O with no JavaScript logic. Everything else —
time, randomness, headers, environment — arrives in the request frame, so the
module is deterministic given its inputs.

The previous incarnation of this proxy ran Vercel's fx agent (`fx-core.wasm`
plus a vendored JS SDK) behind ~2,600 lines of TypeScript. The agent loop, the
tools and the Responses assembly now live in the wasm itself; the request and
response wire format is unchanged.

## Build

```sh
npm install
npm run build        # src-hma/*.hma -> dist/worker.wasm
npm test             # 41 tests drive the wasm with a mocked host
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

No external assembler, no Binaryen, no network. Two changes were made to the
vendored Hot Glue stage 0 (both candidates for upstreaming):
`(use …)` splices at any depth so library files can contribute functions
inside a `(module …)` form, and `print()` memoizes flat renderings (the
naive printer was quadratic on large modules).

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
| `src-hma/search.hma` | all eight search providers |
| `src-hma/kb.hma` | AEM knowledge base: sitemap walk, query-index merge, markdown retrieval |
| `src-hma/agent.hma` | the agent loop, tool schemas, tool dispatch, `web_fetch` |
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
