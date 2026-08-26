# fx-proxy

An OpenAI **Responses API** endpoint backed by [fx](https://fx.sh), Vercel Labs'
minimal coding agent, running as WebAssembly on edge runtimes.

A client sends a plain, tool-free request. Inside the proxy, fx runs a full agent
loop against the underlying model with exactly one tool surface (host-implemented
web search and page fetch), iterates until the question is settled, and the proxy
returns the finished answer as a single Responses object.

```
client ──POST /v1/responses──▶ fx-proxy (Worker)
                                 │
                                 ├─ fx-core.wasm  (agent loop, ACP over stdio)
                                 │     ├─ model calls ─▶ Vercel AI Gateway
                                 │     └─ terminal ────▶ host command surface
                                 │                        web_search / web_fetch
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

Because the sandbox has no real shell, the workspace adapter *is* the tool layer:
every command fx runs is handled in the Worker. That is how a request with no
tools becomes a model with web search.

## Endpoints

| Method | Path | Notes |
| --- | --- | --- |
| `POST` | `/v1/responses` | Responses API. `stream: true` emits SSE. |
| `GET` | `/v1/models` | The configured default model. |
| `GET` | `/health` | Service and configuration summary. |

Supported request fields: `model`, `input` (string or message array),
`instructions`, `stream`, `metadata`, `include`, `max_output_tokens`.

`include: ["fx.debug"]` turns on fx's stderr trace plus per-request logging of the
gateway call (model, message count, advertised tools) and every sandbox command.

Output items mirror OpenAI's built-in web search: each `web_search` call appears
as a `web_search_call` item with a `search` action, each `web_fetch` as one with
an `open_page` action, followed by the assistant `message`. Pass
`include: ["fx.tool_calls"]` to also surface non-search terminal calls as
`custom_tool_call` items. A non-standard `fx` block reports the fx stop reason,
model request count and tool call count.

```bash
curl -sS https://fx-proxy.minivelos.workers.dev/v1/responses \
  -H "authorization: Bearer $AI_GATEWAY_API_KEY" \
  -H "content-type: application/json" \
  -d '{"input":"What changed in Zig 0.16? Cite sources."}' | jq -r .output_text
```

Any OpenAI SDK works by pointing `base_url` at the deployment.

## Tool surface

The model reaches these through fx's terminal tool; the preamble in
`src/agent/prompt.ts` documents them to the model.

```
web_search "<query>" [--count=N] [--site=domain] [--freshness=pd|pw|pm|py] [--json]
web_fetch <url> [--max-chars=N]
help | echo <text> | pwd | date
```

Everything else exits `127` with a usage hint. fx's own egress is restricted to
the model gateway by the allowlist in `src/agent/gateway.ts`, so tools cannot be
used to reach arbitrary hosts on the model's behalf; `web_fetch` additionally
refuses loopback and private address space.

## Configuration

Vars live in `wrangler.jsonc`, secrets go through `wrangler secret put`.

| Name | Kind | Purpose |
| --- | --- | --- |
| `AI_GATEWAY_API_KEY` | secret | Vercel AI Gateway credential fx uses for inference. |
| `PROXY_API_KEY` | secret | Optional. When set, clients must present it and the proxy uses its own gateway key. |
| `SEARCH_API_KEY` | secret | Required by every search provider except `ddg`. |
| `DEFAULT_MODEL` | var | Gateway model id used when a request omits `model`. |
| `MAX_AGENT_STEPS` | var | Ceiling on fx agent steps per request. |
| `SEARCH_PROVIDER` | var | `ddg` (keyless, unofficial), `brave`, `tavily`, `exa`, `serper`. |

Without `PROXY_API_KEY` the proxy is a pass-through: the caller's bearer token is
used as the gateway credential and nothing is stored server-side.

## Development

```bash
npm install          # also vendors fx-core.wasm out of libfx
npm run check        # typecheck + unit tests
npm run dev          # wrangler dev on :8787
npm run deploy       # wrangler deploy
```

Put local secrets in `.dev.vars` (see `.dev.vars.example`).

## Known limits

- **The tool loop is not live yet.** `fx-core.wasm` advertises an empty tool set
  on wasm, so the model currently answers without calling `web_search`. The cause
  and the options are written up in [docs/runtime-notes.md](docs/runtime-notes.md).
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
4. More host tools behind the same terminal surface.

## License

Apache-2.0, matching fx.
