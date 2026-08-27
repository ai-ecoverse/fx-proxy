# Runtime notes

Findings from embedding fx-core into a Hot Glue supervisor, kept for the next
traveler.

## The two-module boundary

Two wasm instances run side by side. `dist/worker.wasm` (the supervisor)
exports `handle`, `alloc`, `memory`, the 51 `g_<name>` gates, and a few
`t_*` test hooks; it imports `host.*`. `vendor/fx-core.wasm` (Vercel's fx,
unmodified) exports `memory` and `_start` and imports 51 functions, all wired
to the supervisor's gates.

The supervisor never imports fx-core. The shim (`src/index.js`) holds both
memories and mediates the two cross-instance copies (`gread` / `gwrite`) and
runs fx's promising `_start` through the suspending `host.fx_start`. So there
is no multi-memory in the wasm — a good thing, since the vendored assembler
does not implement it.

The instantiation order is: supervisor first (needs `host.*`), then fx-core
with its imports bound to the supervisor's gates through a generic loop. fx's
i64 arguments are dropped by per-import trampolines (`FX_IMPORTS` in the shim),
so every gate is pure i32.

## Driving fx

fx-core speaks the Agent Client Protocol (JSON-RPC over stdio) in `acp` mode.
The supervisor's `acp.hma` is a synchronous state machine:

- Outbound requests queue in a byte buffer that fx drains through `fd_read`.
- fx's stdout arrives line by line through `fd_write`, is split on `\n`, and
  each JSON-RPC message advances the state:
  `initialize → session/new → session/set_config_option(model) → session/prompt`.
- `session/update` chunks (`agent_message_chunk`, `agent_thought_chunk`) feed
  the Responses assembler; `session/request_permission` is answered by picking
  the first allow-ish option; the `session/prompt` result carries the stop
  reason.

`handle` seeds the `initialize` request, then calls `host.fx_start`, which
suspends through the entire fx run — every gate that does I/O (`fd_read`,
`fetch_open`, `fx_host_tool_call`) is itself suspending, and JSPI unwinds the
whole nested stack.

## fx speaks the AI-SDK wire protocol

fx's model calls go to `/v3/ai/language-model` (Vercel AI SDK), not OpenAI
chat completions. An offline mock cannot satisfy it, so the tests drive fx to
a terminal gateway status (401) and assert the failed-response path; a full
successful turn needs the real gateway. Verified end to end under workerd
(`wrangler dev`): fx boots through all 51 gates, runs the ACP handshake, calls
the gateway, and its `session/update` error text flows back into a well-formed
Responses object.

## Why no i64 crosses the gate boundary

An implicitly typed function — one with no `(type $t)` reference — takes its
signature from an arity-only key, so the assembler writes every param as i32.
Upstream now refuses a non-i32 valtype there rather than assembling a
signature the source never asked for
([hot-glue#6](https://github.com/ai-ecoverse/hot-glue/pull/6)); before that
fix, `(param $a f64)` produced a *valid module with an i32 parameter*, which
is how this was found. Declaring `(type …)` for all 51 gates would work, but
the arguments are unused or stubbed in every case, so the shim's trampolines
drop them instead and the gates stay pure i32.

Consequences inside `gates.hma`: clocks are a two-word i32 nanosecond
counter, `fd_fdstat_get` writes its rights as four i32 stores, and
`poll_oneoff` reads the timeout's low word only. One further trap for the
unwary: a function with an i64 param must not also declare locals, because
the assembler's local-index inference assumes i32 params — moot here, since
no gate takes one.

## The toolchain

- Stage 0 (`hotglue/bootstrap.ts`) runs under Node's native type-stripping.
- `hotglue/as.wasm` is the self-hosted assembler, run as a WASI reactor under
  `node:wasi`: stdin the WAT, stdout the binary.
- Both are stock upstream Hot Glue at
  [`ca30cad`](https://github.com/ai-ecoverse/hot-glue/commit/ca30cad) — no
  local patches. What this project needed went upstream instead: `(use …)` at
  any depth (#7), the memoized stage-0 printer (#5), and the implicit-signature
  check (#6).
- Refreshing the vendored copies means copying `src/bootstrap.ts` and
  `dist/hotglue/as.wasm` from a bootstrapped hot-glue checkout. `npm run
  bootstrap` there needs wasmtime; the same pipeline runs under `node:wasi`
  (stage 0 renders the three `.wat` files, the previous `as.wasm` assembles the
  new one, and that assembles the rest — the stage-3 fixpoint is the check).

## Memory discipline

- `0..31` scratch (16..23 the gate border staging, 24..31 the clock counter),
  `32..` the interned string pool (the build asserts it stays under 65536),
  `65536..` the runtime registers (`src-hma/slots.hma`), `131072..` a bump
  arena. One instance serves one request and is discarded; there is no free.
- The shim allocates the request frame before calling `handle`, so `alloc`
  self-initialises the heap pointer on first use and neither `handle` nor
  `t_config` resets the arena — the frame's env/header pointers must survive.

## Language notes (the clj accent, for large programs)

- Bare integers self-wrap in `i32.const` only inside accent macros; in plain
  WAT positions (`call` arguments especially) write `(num N)`.
- `while`'s `$break`/`$continue` labels are hygienic — a hand-written
  `(br $break)` inside one silently miscompiles. Use flags or `(return)`.
- Multi-statement branches inside the value-producing `cond` are written as
  `(splice stmt… (num 0))` with a final `(drop)` after the `cond`.
- A string literal in expression position becomes *two* operands (ptr, len).
