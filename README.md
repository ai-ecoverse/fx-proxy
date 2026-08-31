# fx-proxy

An OpenAI **Responses API** endpoint in front of Vercel Labs' **fx** coding
agent, with the entire host layer — the part that used to be JavaScript —
written in [Hot Glue](https://github.com/ai-ecoverse/hot-glue), the macro
assembler for WebAssembly, written in WebAssembly, operating on WebAssembly.

Both deployments are **one wasm module with one linear memory**, linked
ahead of time by `scripts/link.mjs`:

- **`vendor/fx-core.wasm`** — Vercel's fx agent, unmodified (2.6 MB of
  compiled Zig). It owns the agent loop, prompting, tool-argument validation
  and the model conversation.
- **the supervisor**, compiled from the `.hma` sources in `src-hma/`. It
  serves fx-core's 51 imports, routes and validates requests, drives fx over
  ACP, implements the host tools, and assembles the Responses output and SSE
  stream.
- **the seam** (`src-hma/fx-seam.hma`) — nine adapters for the fx imports that
  carry an i64, and WASI's clock.

```
client ──POST /v1/responses──▶ one wasm module, one memory
                                 ├─ router, validation, credentials
                                 ├─ serves fx-core's 51 imports (gates.hma)
                                 ├─ ACP driver (acp.hma) ──▶ fx ──▶ Vercel AI Gateway
                                 ├─ host tools: web_search / web_fetch
                                 │              knowledgebase_list / knowledgebase_get
                                 └─ Responses object or SSE events ──▶ client
```

The two deployments differ in exactly one thing, and it is the thing the
platforms differ in: **whether the host can block.**

| | Cloudflare | Fastly |
| --- | --- | --- |
| host layer | `src/index.js`, ~275 lines | `src-hma/fastly.hma`, no JavaScript |
| I/O | async — every capability suspends through JSPI | synchronous hostcalls; fx's loop simply blocks |
| entry | the shim builds the request frame and calls `handle` | `_start` builds it in wasm |

Fastly forced the single module — it runs one per service and has no nested
instantiation, nor a `WebAssembly` object to instantiate with. Cloudflare does
not force it, but the arrangement is better there too, so both are built the
same way. What it removed from the Cloudflare shim was the whole two-instance
apparatus: binding fx's fifty-one imports, the trampolines dropping their i64
arguments, a second instantiation, and the two byte-copies that mediated
between two memories — 103 crossings into JavaScript per turn, now
`memory.copy` inside the module.

A client sends a plain, tool-free request. The supervisor drives fx-core
through the Agent Client Protocol (`initialize` → `session/new` →
`session/prompt`); fx runs its agent loop against the model with the
supervisor's host tools (web search, page fetch, an optional AEM knowledge
base), and its streamed `session/update` chunks are assembled into a single
Responses object — or a Responses-shaped SSE stream.

Status: experimental. Cloudflare account *AEM Demo*:

| | |
| --- | --- |
| production | `https://fx-proxy.minivelos.workers.dev` |
| staging | `https://fx-proxy-staging.minivelos.workers.dev` |

Neither deployment stores a credential. With `AI_GATEWAY_API_KEY` unset the
proxy forwards the caller’s bearer token to the gateway and holds nothing of
its own, so an open `workers.dev` URL cannot spend on its own; staging also
uses keyless `ddg` search for the same reason.

It also runs on **Fastly Compute**, at
`https://eagerly-witty-burro.edgecompute.app`, with no JavaScript at all —
fx's agent loop blocks on Fastly's synchronous hostcalls exactly where it
suspends through JSPI on Cloudflare, so that port needs no stack switching.
See [docs/fastly.md](docs/fastly.md).

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
npm run build            # src-hma/*.hma -> dist/worker.wasm
npm test                 # 42 tests drive the wasm with a mocked host
npm run test:hma         # Hot Glue suites, asserted inside wasm
npm run dev              # wrangler dev
npm run deploy           # production
npm run deploy:staging   # fx-proxy-staging
```

`npm test` is offline and free. The success path needs a real gateway, because
fx speaks Vercel's AI-SDK wire protocol and no offline mock completes a turn,
so those three tests skip unless a credential is present:

```sh
AI_GATEWAY_API_KEY=vck_… npm test     # + 3 live tests, a few tokens each
```

They let the worker reach the network for real: a plain turn, a turn where fx
calls `web_search` and the supervisor serves it, and a streamed turn.

`npm run test:hma` is a second, smaller kind of test: `test-hma/*-test.hma` are
Hot Glue modules that assert against the proxy's own layers *in wasm*, with no
TypeScript in the room. They use [Hot Glue's `glue-test.hma`][hg] — a
clojure.test poured into macros, where the test roster lives in the macro table
and the plan is finished before the first byte of wasm exists — and run under
`node:wasi`, so no wasmtime is needed and nothing beyond the toolchain
already in `package.json`. Each suite is
its own verdict: it prints a transcript and exits nonzero when an assertion
fails.

[hg]: https://github.com/ai-ecoverse/hot-glue

## Post-deploy smoke test

The two deployments are built differently and should be indistinguishable to a
client, so one file checks both:

```sh
npm run smoke:fastly           # free checks; the three that spend skip
npm run smoke:staging
AI_GATEWAY_API_KEY=vck_… npm run smoke:fastly    # all fourteen

SMOKE_URL=https://… node --test scripts/smoke.mjs
```

`scripts/smoke.mjs` runs on Node's own test runner with **no dependencies at
all** — it wants `fetch` and `node:test`, both in the runtime since 18. That is
the point: a post-deploy check should run from anywhere against anything
without installing this project first. `npm ci` is not a prerequisite for
asking a URL whether it is healthy.

It asserts what a client can see — the shape of `/health`, CORS, 404 and 405,
401 without a credential, the exact message a truncated or badly escaped body
comes back with, then a turn, a tool call and the SSE event sequence. It never
asserts what the model *said*; that is the model's business and makes for a
flaky test. Without a key the three checks that reach the model skip and the
rest still run, because a malformed body is refused before fx starts and before
the gateway is called — so those pass a throwaway bearer token and spend
nothing.

The check it exists for is `agent == "hotglue"`. A stale deployment is alive,
answers correctly and is the wrong build — which is exactly what
`fx-proxy.minivelos.workers.dev` turned out to be, still serving `"agent":
"fx"` from before the Hot Glue rewrite. Pointed there it exits 1 on that and on
the older, vaguer JSON error message.

Fastly takes a few minutes to propagate an activation, so give a deploy time
before believing a failure.

## JSON, from the library

`src-hma/json.hma` no longer parses anything. It is a span adapter over
[Hot Glue's][hg] `json-read.hma` and `json-write.hma`: the proxy still navigates
by span — `$jget` hands back a value's bytes so the caller can hand them to
`$jget` again — but escapes, `\uXXXX`, surrogate pairs, number spelling and
structural skipping all come from the shared, tested libraries.

The bridge is one observation: after the event that ends a value, the reader's
input cursor *is* the end of that value. A string ends on its closing quote, a
literal on its last byte, a container on its bracket, and a number pushes its
delimiter back, so the rule needs no special case. The start is the first byte
after the previous event that is not whitespace, a comma or a colon — nothing
else can stand there.

Request bodies additionally get one whole pass for the verdict
(`src-hma/jvalid.hma`), which the span API cannot give: a cursor reads only the
keys it is asked for, so a truncated body used to read as "every key absent"
and fail later, somewhere less honest. Now it is named:

```console
$ curl … -d '{"input":"hi'
{"error":{"message":"request body is not valid JSON: the document ended in the
middle of a value","type":"invalid_request_error",…}}
```

This costs something, because the reader tokenizes — decoding every string it
passes — where the old scanner only walked bytes looking for structure. Doing
that once per *question* would be much worse than the parser it replaced, so a
container is read once and its members remembered; `$jget`, `$jskip` and
`$jcount` then answer from that index. `$parse-request` alone asks a body ten
questions.

Median of three runs through the harness, against the hand-rolled scanner:

| body | no index | with index |
| --- | ---: | ---: |
| 6 KB | +54% | **+30%** |
| 18 KB | +81% | **+6%** |
| 66 KB | +154% | **+22%** |

— against the ~32 ms of CPU a request already spends, and none of it on the
model's clock. `test-hma/json-test.hma` was written against the old
implementation first, so it is the evidence that the new one behaves the same;
it also pins the ways an index can lie: eviction, re-walking an array, a
duplicated key.

The libraries ship their state at fixed addresses — 8192 for the reader, 8448
for the writer — which in this program is the middle of the interned string
pool, where the lowerer puts every string literal. `src-hma/glue-mem.hma`
shadows the toolchain's copy of that memory map and *derives* the bands instead,
through Hot Glue's `(take …)` allocator, above everything this program pins.

Each band is taken **guarded**, so it ends in a four-byte sentinel: `$handle`
arms them and `$fx-drive-tail` checks them, which is the moment after fx-core
has had the run of the address space. On Fastly there is one more at 4 MB, where
this module's arena and fx-core's descending stack face each other with nothing
in the wasm between them. `test-hma/glue-json-test.hma` is the evidence the
bands moved; `test-hma/canary-trap.hma` writes one word too far and must die at
the tripwire. Both matter because the corruption they replace was silent.

## The toolchain

Hot Glue is a devDependency — `@ai-ecoverse/hot-glue` — so the expander and
every library it ships update with `npm update`, and "stock upstream, no local
patches" is a version rather than a claim to check by diffing.

One artifact stays vendored: `hotglue/as.wasm`, the self-hosted assembler,
which the package does not publish. It runs as a WASI reactor under
`node:wasi`. Nothing in the build reaches the network.

The package is pinned exactly rather than with a caret, because that assembler
is vendored at a particular commit and the two have to agree — a bump should be
a decision that also asks whether `as.wasm` needs refreshing.

`src-hma/glue-mem.hma` shadows the library of the same name, which still works
the same way: `(use …)` resolves against this program's directory before the
package's.

## The Hot Glue sources

| File | Owns |
| --- | --- |
| `src-hma/worker.hma` | the Cloudflare entry: module shell, `host.*` imports, memory |
| `src-hma/worker-fastly.hma` | the Fastly entry: the `fastly_*` ABI, `_start`, compiled-in config |
| `src-hma/worker-core.hma` | runtime-agnostic: request frame intake, config, credentials, router, request validation |
| `src-hma/glue-mem.hma` | the glue libraries' memory map, shadowing the toolchain's |
| `src-hma/fastly.hma` | the host layer on Fastly's hostcalls |
| `src-hma/slots.hma` | the request-scoped register map (macros only) |
| `src-hma/rt.hma` | bump allocator, growable buffers, string ops |
| `src-hma/json.hma` | span navigation over Hot Glue's reader and writer — no parser of its own |
| `src-hma/jvalid.hma` | one whole-document pass, purely for the verdict on a request body |
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
call count.

`usage` is reported as zeros. fx owns the model conversation and does not
surface token counts over ACP — the gateway's responses cross the boundary as
opaque bytes for fx to parse — so there is nothing to count here. The
`model_requests` and `tool_calls` in the `fx` block are real, since the
supervisor serves those calls itself.

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
