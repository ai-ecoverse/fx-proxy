# fx-proxy

An OpenAI **Responses API** endpoint backed by [fx](https://fx.sh), Vercel Labs'
minimal coding agent, running as WebAssembly on edge runtimes.

This repo depends on the patched fx in
[`trieloff/fx@wasm-host-tools`](https://github.com/trieloff/fx/tree/wasm-host-tools)
(currently `e76e24fa`). Upstream `libfx` advertises no tools on wasm; that
branch is what supplies `fx-core.wasm` and the host-declared `tools` option.

A client sends a plain, tool-free request. Inside the proxy, fx runs a full agent
loop against the underlying model with a host-implemented tool surface (web search,
page fetch, and an optional AEM knowledge base), iterates until the question is
settled, and the proxy returns the finished answer as a single Responses object.

```
client ──POST /v1/responses──▶ fx-proxy (Worker)
                                 │
                                 ├─ fx-core.wasm  (agent loop, ACP over stdio)
                                 │     ├─ model calls ─▶ Vercel AI Gateway
                                 │     └─ tool calls ──▶ host tools, run in the Worker
                                 │                        web_search / web_fetch
                                 │                        knowledgebase_list / knowledgebase_get
                                 └─ Responses object or SSE stream ──▶ client
```

Status: experimental. Deployed at `https://fx-proxy.minivelos.workers.dev`
(Cloudflare account *AEM Demo*).

## Why this works

fx ships `fx-core.wasm` plus a dependency-free JS host layer (`libfx/wasm`). The
host supplies network transport, session storage, config and a workspace adapter;
the WebAssembly runtime deliberately has no filesystem, no subprocesses and no
web tools of its own. Cloudflare's runtime supports WebAssembly JSPI
(`WebAssembly.Suspending` / `WebAssembly.promising`), which is what fx's host
layer needs, so the agent runs unmodified at the edge.

The proxy declares its own tools to fx at startup. Each declaration carries a
JSON Schema that fx advertises to the model unchanged and enforces before the
handler runs, so the model sees ordinary function calls and the implementations
stay in the Worker. That is how a request with no tools becomes a model with web
search.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/responses` | Responses API. `stream: true` emits SSE. |
| `GET` | `/v1/models` | The configured default model. |
| `GET` | `/health` | Service and configuration summary. |

Supported request fields: `model`, `input` (string or message array),
`instructions`, `stream`, `metadata`, `include`, `max_output_tokens`.

`include: ["fx.debug"]` turns on fx's stderr trace plus per-request logging of the
gateway call (model, message count, advertised tools) and every tool call with its
arguments.

Output items mirror OpenAI's built-in web search: each `web_search` call appears
as a `web_search_call` item with a `search` action, each `web_fetch` as one with
an `open_page` action, followed by the assistant `message`. A non-standard `fx`
block reports the fx stop reason, model request count and tool call count.

```bash
curl -sS https://fx-proxy.minivelos.workers.dev/v1/responses \
  -H "authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"input":"What changed in Zig 0.16? Cite sources."}' | jq -r .output_text
```

Any OpenAI SDK works by pointing `base_url` at the deployment.

## Tool surface

Host tools are declared in `src/agent/tools.ts` and advertised on every model call:

| Tool | Arguments | When |
| --- | --- | --- |
| `web_search` | `query` (required), `count`, `site`, `freshness: day\|week\|month\|year` | always |
| `web_fetch` | `url` (required), `max_chars` | always |
| `knowledgebase_list` | `prefix`, `query`, `limit` | `x-org` and `x-repo` headers are set |
| `knowledgebase_get` | `path` (required), `max_chars` | `x-org` and `x-repo` headers are set |

Arguments are validated against those schemas inside fx, so a malformed call is
rejected before the Worker runs anything. `src/agent/prompt.ts` adds only what a
schema cannot express: when to search, and that fetched content is untrusted.

### AEM knowledge base

When a request includes both `x-org` and `x-repo`, the proxy binds the published
Edge Delivery site `https://{ref}--{repo}--{org}.aem.live` (`x-ref` defaults to
`main`) and advertises the two knowledge-base tools. `knowledgebase_list` reads
`/sitemap.xml` (and titles from `/query-index.json` when present);
`knowledgebase_get` fetches `/{path}.md`. `adobe/aem-website` is the reference
shape: `https://main--aem-website--adobe.aem.live/sitemap.xml` and
`/developer/block-collection.md`.

```bash
curl -sS https://fx-proxy.minivelos.workers.dev/v1/responses \
  -H "authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -H "x-org: adobe" \
  -H "x-repo: aem-website" \
  -d '{"input":"How do sitemaps work on AEM? Cite the docs."}'
```

Aliases: `x-owner` for org, `x-site` for repo, `x-aem-org` / `x-aem-repo` /
`x-aem-ref`. The tools are omitted entirely when the headers are absent, so a
generic client never sees a knowledge base it cannot reach.

fx's own egress is restricted to
the model gateway by the allowlist in `src/agent/gateway.ts`, so tools cannot be
used to reach arbitrary hosts on the model's behalf; `web_fetch` additionally
refuses loopback and private address space.

## Configuration

Vars live in `wrangler.jsonc`, secrets go through `wrangler secret put`.

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | secret | Vercel AI Gateway credential fx uses for inference. |
| `PROXY_API_KEY` | secret | Optional. When set, clients must present it and the proxy uses its own gateway key. |
| `SEARCH_API_KEY` | secret | Required by `brave`, `tavily`, `exa`, and `serper`. |
| `DEFAULT_MODEL` | var | Gateway model id used when a request omits `model`. |
| `MAX_AGENT_STEPS` | var | Ceiling on fx agent steps per request. |
| `SEARCH_PROVIDER` | var | `ddg` (keyless, unofficial); `brave`, `tavily`, `exa`, `serper` (own keys); `perplexity`, `parallel`, `tako` (Vercel AI Gateway server tools, billed on the request's gateway key). |

Without `PROXY_API_KEY` the proxy is a pass-through: the caller's bearer token is
used as the gateway credential and nothing is stored server-side.

## Development

The agent artifacts come from a patched fx checkout (see
[docs/runtime-notes.md](docs/runtime-notes.md)); `vendor/` is not committed.

```bash
# once: build the agent (Zig 0.16+, ~70 s)
git clone -b wasm-host-tools https://github.com/trieloff/fx.git ~/Developer/vercel-labs/fx
(cd ~/Developer/vercel-labs/fx && zig build -Dwasm-surface=core -Doptimize=ReleaseSmall)

npm install          # vendors fx-core.wasm and fx-sdk.js from that checkout
npm run vendor       # re-vendor after rebuilding fx
npm run check        # typecheck + unit tests
npm run dev          # wrangler dev on :8787
npm run deploy       # wrangler deploy
```

`FX_SRC` overrides the checkout location and `FX_CORE_WASM` points directly at an
artifact. Put local secrets in `.dev.vars` (see `.dev.vars.example`).

## Known limits

- **A patched fx build is required**, both `fx-core.wasm` and `fx-sdk.js`.
  Upstream fx advertises an empty tool set on wasm and its host layer has no
  `tools` option, so the published `libfx` package reasons but never searches.
  Build the branch described in [docs/runtime-notes.md](docs/runtime-notes.md);
  the vendor script warns when it falls back to the published artifact.
- `previous_response_id` is rejected: sessions are not persisted yet.
- `usage` is reported as zeros; token accounting needs gateway response parsing.
- Image and file inputs, and client-side tool results, are unsupported.
- Workers CPU time bounds how long an agent loop may run.
- The `ddg` provider scrapes an undocumented HTML endpoint; use a keyed provider
  for anything real.

## Roadmap

1. Token usage accounting from gateway responses.
2. Session persistence (KV or Durable Objects) for `previous_response_id`.
3. A second deployment target on Fastly Compute.
4. More host tools; the declaration path takes up to 16.

## License

Apache-2.0, matching fx.
