# Runtime notes

Findings from getting fx to run inside Cloudflare Workers, and how the tool
surface was closed.

**Resolved, in two steps**, both kept on forks of fx:

1. [`trieloff/fx@wasm-core-workspace-tools`](https://github.com/trieloff/fx/tree/wasm-core-workspace-tools)
   made the embedded ACP surface load the JavaScript host workspace and advertise
   the existing one-command `terminal` tool. That was enough to run the loop, but
   every capability had to be described in prose and invoked as a free-text
   command.
2. [`trieloff/fx@wasm-host-tools`](https://github.com/trieloff/fx/tree/wasm-host-tools)
   adds host-declared tools: the host hands fx a manifest of tools with JSON
   Schemas, fx advertises them unchanged and validates arguments before calling
   back into the host. This is what the proxy uses now.

`zig build test` passes (8603 tests) and `zig fmt --check` is clean on both.
Build it and point this repo at the artifacts:

```bash
git clone -b wasm-host-tools https://github.com/trieloff/fx.git ~/Developer/vercel-labs/fx
cd ~/Developer/vercel-labs/fx && zig build -Dwasm-surface=core -Doptimize=ReleaseSmall
cd - && npm run vendor     # or FX_CORE_WASM=/path/to/fx-core.wasm npm run vendor
```

Both artifacts matter: `vendor/fx-core.wasm` and `vendor/fx-sdk.js`. The patched
host layer is not in the published `libfx` package, so `wrangler.jsonc` aliases
`libfx/wasm` to the vendored copy.

Verified through the proxy with `alibaba/qwen3.7-flash`: one request produced four
tool calls (three `web_search`, one `web_fetch`) and an answer cited from the
fetched source.

The rest of this document records why the published artifact cannot do that.

## What works

- **JSPI on Workers.** `WebAssembly.Suspending` and `WebAssembly.promising` are
  available in workerd, locally and in production. libfx's host layer needs both,
  and `fx-core.wasm` instantiates and runs an ACP session unmodified.
- **Bundle size.** `fx-core.wasm` is 2.5 MiB, and the deployed Worker gzips to
  well under the script limit.
- **Host bridges.** The gateway `fetch` bridge, session store, permission
  callback and stderr forwarding all behave as documented; a request completes in
  a few seconds and errors surface cleanly through the Responses API shape.
- **Cost of a cold agent.** Instantiating fx per request measured ~4 ms of
  startup time in `wrangler deploy` output.

## Blocker 1: fx-core advertises no tools on wasm

Verified against `libfx@0.0.6` and against a local `zig build -Dwasm-surface=core`
of `main` (commit `fed5aa2`):

```
gateway request keys=[prompt, tools, toolChoice] tools=[]
```

The model receives an empty tool array, so it narrates what it would do (`I will
search the web…`) and stops. Two independent reasons, both intentional upstream:

1. `src/acp/prompt.zig`:

   ```zig
   fn activeToolSet(state: *const server.ServerState) tool_set_contract.ToolSet {
       if (comptime host_target.is_wasm) return tool_set_contract.empty;
       return if (state.cfg.allow_native_tools) builtin_tools.advertisement_set else tool_set_contract.empty;
   }
   ```

   The headless ACP surface (`fx-core.wasm`, what `createFxAgent()` runs) returns
   an empty tool set on wasm unconditionally.

2. The host workspace surface is compiled only into the *terminal* artifact.
   `fx-core.wasm` does not even import `fx_workspace_available` /
   `fx_workspace_info` / `fx_workspace_exec`, while `fx-term.wasm` does. So the
   workspace adapter this proxy provides is never consulted:
   `main.zig`'s `effectiveToolSet()` → `browser_workspace_tools.selectToolSet()`
   is on the terminal path only.

`fx-term.wasm` cannot substitute: `runWasmTerminal` rejects non-interactive
launches with `error.WasmTerminalInteractiveLaunchRequired`, so `fx ask --json`
is unavailable and only a real TUI session can be driven.

ACP client capabilities do not help either. `parseInitializeRequest` records
`clientCapabilities.terminal` and `clientCapabilities.fs` into `ServerState`, but
nothing reads those fields when selecting tools.

### Patch 1: workspace terminal

Two files in `src/acp/`:

- `server.zig` — `ServerState` gains `workspace_host` (a `js_host_workspace.Runtime`
  on wasm, an empty struct otherwise) plus `workspaceHostInfo()` and
  `workspaceExecutor()` accessors. `handleInitialize` loads the runtime after the
  startup state and, when a workspace is present, replaces `workspace_root` with
  the host's root so the model's turn context stops reporting `/`.
- `prompt.zig` — `activeToolSet` returns
  `browser_workspace_tools.selectToolSet(false, state.workspaceHostInfo() != null)`
  on wasm; `toolContext()` passes `workspace_executor` and the
  `host_sandbox_default` derived from the host's `permission` value;
  `executeWebToolCall` is gone, and `executeToolCall` returns the
  unavailable-host result on wasm only when no workspace is offered.

## Blocker 2: a terminal command is not a tool

With patch 1 the model saw exactly one tool, `terminal`, and the proxy's
capabilities lived inside its `command` string. The consequences were real:

- No argument schema. `--count=abc` reached the Worker's tokenizer, not the
  model API's validator.
- The contract was prose, so a model that knew fx's own `web_search` tool emitted
  it as a tool call. fx answered `Unsupported tool`, and a production run spent
  its whole budget without searching once.
- fx's `terminal` description is written for the browser demo and promises `rg`,
  `sed`, `jq` and redirection, none of which exist here, so the proxy had to spend
  prompt text overriding it.

MCP is not an alternative: fx advertises the meta-tools `mcp_search_tools` and
`mcp_select_tool` for discovery rather than the tools themselves, and MCP is
compiled out of the wasm profile.

### Patch 2: host-declared tools

Three new imports mirror the workspace ones: `fx_host_tools_available`,
`fx_host_tools_info` (a bounded v1 JSON manifest) and `fx_host_tool_call`
(suspending). New module `src/core/hosts/js_host_tools.zig` parses the manifest
into a runtime `[]Tool`, and the ACP server merges that set with the workspace
terminal when both exist.

Two details made it possible without a fork of the whole tool layer:

- `model_tool_schema.FunctionSchema` holds plain slices, and `Tool` gained an
  `advertisement_json` field, so a host's own JSON Schema reaches the provider
  verbatim instead of being remapped into fx's schema structs.
- The dispatch callbacks (`DecodeFn`, `CallFn`, `ReadsOnlyFn`) never learn which
  tool they belong to, and function pointers cannot carry runtime state. Per-tool
  identity therefore comes from comptime generated slots indexing one metadata
  table, capped at 16 tools.

Arguments are checked with fx's existing JSON Schema validator
(`src/core/mcp/json_schema.zig`) before a handler runs, and the wasi execution
gate in `tool_runtime.zig`, which previously rejected everything that was not the
single `terminal` tool, now dispatches host tools.

The host side is a `tools: [{ name, description, parameters, handler }]` option in
`sdk/fx-sdk.js`, covered by `sdk/tests/test-core-host-tools.mjs`, which asserts
the schema is advertised byte-identically and that the handler receives the parsed
arguments.

### Considered and rejected

- **Move the tool loop into the proxy** by injecting a `web_search` tool into the
  request fx sends to `/v3/ai/language-model` and looping in the Worker. No fork,
  but it means implementing the AI Gateway language-model v3 wire format in both
  directions, and fx would be reduced to prompt and session management.
- **A proxy-owned agent loop** driving the model directly. Simplest, but the
  deployment would no longer run fx.

## Follow-ups

- Neither patch is upstream yet. Until they are, `vendor/` has to be built
  locally, which `scripts/vendor-fx.mjs` handles and warns about.
- The host tool manifest is capped at 16 tools, 8 KiB per schema and 96 KiB per
  result. Those bounds are arbitrary but deliberate: the manifest crosses a
  trust boundary into the sandbox.
- Host tools are advertised on every model call. Selective advertisement (fx's
  `mcp_select_tool` pattern) would matter only with many more tools.
