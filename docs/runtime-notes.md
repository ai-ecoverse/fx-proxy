# Runtime notes

Findings from getting fx to run inside Cloudflare Workers, and the one blocker
that remains.

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

## Ways forward

1. **Patch fx-core** so the ACP wasm surface exposes the existing browser
   workspace terminal tool: initialise `js_host_workspace.Runtime` in the ACP
   server state, return `browser_workspace_tools.selectToolSet(false, available)`
   from `activeToolSet`, and route `terminal` execution through the workspace
   executor. Keeps fx as the agent, needs a Zig build step (Zig 0.16, ~75 s) and
   a vendored artifact, and is a plausible upstream contribution.
2. **Move the tool loop into the proxy.** Inject a `web_search` tool into the
   request fx sends to `/v3/ai/language-model`, run the tool-call loop in the
   Worker, and hand fx a final tool-free assistant message. No fork, but it means
   implementing the AI Gateway language-model v3 wire format in both directions,
   and fx is reduced to prompt and session management.
3. **Proxy-owned agent loop.** Skip fx for inference and drive the model
   directly. Simplest and most robust, but the deployment no longer runs fx.

Everything in this repository other than tool advertisement is independent of
that choice: the Responses API surface, the sandbox command layer, `web_search`
and `web_fetch`, and the egress allowlist stay as they are.
