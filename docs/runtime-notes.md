# Runtime notes

Findings from getting fx to run inside Cloudflare Workers, and how the tool
surface was closed.

**Resolved.** The gap described below is fixed by a patch to fx itself, kept on
[`trieloff/fx@wasm-core-workspace-tools`](https://github.com/trieloff/fx/tree/wasm-core-workspace-tools):
the embedded ACP surface now loads the JavaScript host workspace, advertises the
existing one-command `terminal` tool, and routes execution through the workspace
executor. `zig build test` passes and `zig fmt --check` is clean. Build it and
point this repo at the artifact:

```bash
git clone -b wasm-core-workspace-tools https://github.com/trieloff/fx.git ~/Developer/vercel-labs/fx
cd ~/Developer/vercel-labs/fx && zig build -Dwasm-surface=core -Doptimize=ReleaseSmall
cd - && npm run build:wasm     # or FX_CORE_WASM=/path/to/fx-core.wasm npm run build:wasm
```

Verified through the proxy with `alibaba/qwen3.7-flash`: 8 tool calls in one
request (3 `web_search`, 2 `web_fetch`), answer cited from the fetched source.

The rest of this document records why the published artifact cannot do that.

## What works

- **JSPI on Workers.** `WebAssembly.Suspending` and `WebAssembly.promising` are
  available in workerd, locally and in production. libfx's host layer needs both,
  and `fx-core.wasm` instantiates and runs an ACP session unmodified.
- **Bundle size.** `fx-core.wasm` is 2.2 MiB, 783 KiB gzipped, well inside the
  Worker script limit.
- **Host bridges.** The gateway `fetch` bridge, session store, permission
  callback and stderr forwarding all behave as documented; a request completes in
  a few seconds and errors surface cleanly through the Responses API shape.
- **Cost of a cold agent.** Instantiating fx per request measured ~4 ms of
  startup time in `wrangler deploy` output.

## The blocker: fx-core advertises no tools on wasm

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

## The patch

Three edits, both files in `src/acp/`:

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

Nothing native changes: the native branch of every touched function is untouched,
and the wasm branches were previously dead ends.

### Considered and rejected

- **Move the tool loop into the proxy** by injecting a `web_search` tool into the
  request fx sends to `/v3/ai/language-model` and looping in the Worker. No fork,
  but it means implementing the AI Gateway language-model v3 wire format in both
  directions, and fx would be reduced to prompt and session management.
- **A proxy-owned agent loop** driving the model directly. Simplest, but the
  deployment would no longer run fx.

## Follow-ups

- fx's `terminal` tool description is written for the browser demo and promises
  `rg`, `sed`, `jq`, `mkdir` and redirection. This sandbox has none of them, so
  `src/agent/prompt.ts` explicitly overrides that description. A host-supplied
  tool description would be a cleaner upstream contract.
- The patch is not upstream yet. Until it is, `vendor/fx-core.wasm` has to be
  built locally, which `scripts/vendor-wasm.mjs` handles and warns about.
