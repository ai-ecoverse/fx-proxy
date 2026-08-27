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

## The i64 assembler limitation

`hotglue/as.wasm` recognises i64 mnemonics in its opcode table but its const /
load / store emitters trap on them, and `$count-i32` (used for function-type
dedup keys) counts only i32 valtypes — so a signature with an i64 param
collapses onto a different arity and the body's local indices go out of range.
i64 *valtypes* in signatures are fine; i64 *instructions* and i64-param
dedup are not. Rather than patch and re-bootstrap the assembler, the shim's
trampolines keep i64 out of the wasm entirely (see above). Clocks are a
two-word i32 nanosecond counter; `fd_fdstat_get` writes its rights as four
i32 stores; `poll_oneoff` reads the timeout's low word only.

## The toolchain

- Stage 0 (`hotglue/bootstrap.ts`) runs under Node's native type-stripping.
- `hotglue/as.wasm` is the self-hosted assembler, run as a WASI reactor under
  `node:wasi`: stdin the WAT, stdout the binary.
- Stage-0 changes made here (upstream candidates): `(use …)` resolves at any
  depth so a `(module …)` can splice function libraries, and `print()`
  memoizes flat renderings (the original was quadratic — a 60 KB module took
  minutes to print and now takes milliseconds).

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
- A function with an i64 param must not also declare locals (the assembler's
  local-index inference assumes i32 params) — moot here since no gate uses i64.
