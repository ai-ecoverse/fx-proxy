# Runtime notes

Findings from embedding fx-core into a Hot Glue supervisor, kept for the next
traveler.

## One module, one memory

Both deployments link fx-core, the supervisor and the i64 seam into a single
module ahead of time (`scripts/link.mjs`). This section used to describe two
instances side by side, with a JS shim holding both memories and mediating
every byte between them; that arrangement is gone.

Fastly forced it — one module per service, no nested instantiation, no
`WebAssembly` object to instantiate with. Cloudflare tolerated the two-instance
version but is better off without it: binding fx's fifty-one imports, the
trampolines that dropped their i64 arguments, the second instantiation and the
two cross-memory copies were all apparatus for a boundary that no longer
exists. `$host-gread`/`$host-gwrite` kept their names and became `memory.copy`
in `worker-core.hma` — 103 crossings into JavaScript per turn, now none.

The supervisor exports `handle`, `alloc`, `memory`, the 51 `g_<name>` gates and
a few `t_*` test hooks; after the link the module also exports `fx_core_start`,
which is how Cloudflare's shim re-enters fx through `WebAssembly.promising`.
fx's i64-bearing imports are bound to the seam's adapters, the rest straight to
the gates, so no i64 crosses into the assembler's dialect either way.

The memories fuse because the supervisor *imports* `(memory 261)` rather than
declaring one, and the link resolves that against fx-core's export. The
layouts do not collide: fx keeps a 16 MB stack falling from 16 MB, its data at
16 MB, and takes its heap from the single `memory.grow` it performs; the
supervisor lives in 0..4 MB, the deep end of that stack. Nothing in the wasm
enforces the gap, so on Fastly a canary sits at 4 MB and catches either side
crossing (see `docs/fastly.md`).

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

## Performance against the JavaScript host

The old host layer and this one drive the same fx-core, so they can be
compared directly. Measured with both stacks served side by side on one
machine by the same wrangler, requests interleaved, 50 paired samples, the
same prompt on the same cheap model.

| | min | p50 | p90 | max |
| --- | ---: | ---: | ---: | ---: |
| JS host | 1.01s | 1.42s | 1.99s | 2.18s |
| wasm host | 1.16s | 1.89s | 3.05s | 5.93s |

The wasm host was slower in 41 of 50 pairs, median +440ms, and five of its
requests exceeded three seconds against none for the JS host.

That is wall time, and Workers bills CPU time. On that measure the two are the
same. Sixteen `wrangler tail` samples of each deployment, taken under
interleaved load:

| | mean CPU | p50 | p90 | wall p50 |
| --- | ---: | ---: | ---: | ---: |
| JS host | 32.1ms | 33ms | 38ms | 1178ms |
| wasm host | 31.6ms | 32ms | 36ms | 1623ms |

So the extra wall time costs nothing to run: it is spent suspended, not
computing. What it costs is latency a caller can feel, and headroom against
the request duration limit. Memory is likewise not a concern — the
supervisor's own linear memory never grows past its initial 4 MB, and
fx-core's 27 MB dominates both stacks identically.

The cost is in the streaming read. A phase probe in the shim, timing each
outbound call, shows total time tracking the number of chunk reads rather than
anything else:

| total | time to first byte | stream read | reads |
| ---: | ---: | ---: | ---: |
| 1179ms | 637ms | 113ms | 20 |
| 1468ms | 601ms | 359ms | 40 |
| 2463ms | 919ms | 1150ms | 80 |
| 3873ms | 1475ms | 2065ms | 172 |

fx asks for up to 16 KB per read; each read is a JSPI suspension that unwinds
through two wasm modules, and the host answered each one with whatever a
single `reader.read()` happened to yield — often one small frame of the SSE
body. The JS host paid one boundary crossing per read; this one pays several.

Ruled out along the way, each by measurement rather than argument: sleeping in
`poll_oneoff` (zero calls, under both Node and workerd), the cross-memory
mediation (103 crossings per turn, 294 KB), instantiation (`/health`
instantiates both modules and matches the JS host), and extra model traffic
(both issue exactly two gateway requests per turn).

Two attempts to close the gap did not, and are recorded so the next person
skips them. Writing the chunk straight into fx's memory rather than bouncing
it through the supervisor's removed a copy and a 16 KB arena allocation per
read — kept for those, since an arena that never shrinks otherwise grows by up
to a megabyte over a request — but it moved the paired median the wrong way,
well inside run-to-run noise. Coalescing chunks behind a pump was reverted: it
barely changed the read count, because the whole streamed body is 2–6 KB
arriving as roughly 60-byte frames at the model's pace, so there is nothing
queued to coalesce.

What that leaves is the cost of a suspension itself, one per token — and
since CPU is flat, that cost is not compute but the scheduling around each
suspend and resume.

**These figures predate the single-module link and have not been re-measured.**
The structure they were taken against — two instances, a JS shim mediating
every byte — is gone. What that removed is the cross-memory mediation, which
the table above had already measured (103 crossings per turn, 294 KB) and ruled
out as the cause; the per-token suspension it did *not* remove is still there,
because Cloudflare's I/O is still asynchronous. A paired live comparison of
seven turns each showed no difference outside network noise, which is the
expected result and not evidence of one. Re-running the interleaved 50-sample
method above is the way to say anything more.

The remaining idea is the same one: bind `fx_http_stream_next` straight to the
host and leave the supervisor holding the stream's opening, where the egress
check lives, so the hot path stops crossing a boundary per token.

## The toolchain

- Everything comes from **`@ai-ecoverse/hot-glue`**, an ordinary devDependency.
  Since 0.3.0 the package ships its own compiled organs — `as.wasm`,
  `expand.wasm`, `hotglue.wasm` — beside the `.hma` sources that determine
  them, so `compile()` goes from source to a wasm binary in one call, driven
  from Node. Nothing external, nothing on the network.
- This repository used to vendor `hotglue/as.wasm`, because the package
  published the assembler's source and not its binary, and `scripts/*.mjs`
  carried about twenty-five lines running it as a WASI reactor over stdin and
  stdout. Both are gone. The directory is gone.
- The dependency is pinned **exactly**. The old reason — a hand-vendored binary
  that had to agree with the package — has gone with the binary. The remaining
  one is that the toolchain determines our output bytes, and the check every
  toolchain change here has been carried by is that both targets rebuild
  byte-identically; a patch bump arriving on its own would answer that check
  before anyone asked it.
- `compile()` returns `{ wat, bin }` and **both are `Uint8Array`**. `bin` is the
  binary; `wat` needs `Buffer.from(wat).toString()` if you want to read it. The
  string-pool assertion in `build-wasm.mjs` and the unresolved-call check in
  `hma-test.mjs` are the only two places that do.
- The lookup path is bounded: `hotglue.wasm` probes fds 3 through 9, so seven
  directories, and the driver adds its own to whatever is passed. Two from this
  project is comfortable; a long list would silently push the shipped sources
  out of reach, which only shows up outside a checkout where `./src` is not
  there to answer by accident.
- `src-hma/glue-mem.hma` still shadows the library of that name. `(use …)`
  resolves against the passed directories before the package's own, so the
  shadow wins exactly as it did when the libraries sat in `hotglue/`.
- What this project needed went upstream rather than staying here: `(use …)` at
  any depth (#7), the memoized stage-0 printer (#5), the implicit-signature
  check (#6), the move of every base address into `glue-mem.hma`, then
  `glue-alloc.hma` and `canary.hma`, and finally the shipped organs (#20) that
  retired the vendoring altogether.
- The failure mode if the `glue-mem.hma` shadow ever stops working is silent —
  the writer's error flag stays 0 while its output is quietly overwritten by
  string literals. `test-hma/glue-json-test.hma` exists to catch it, and every
  band is taken guarded, so a write that leaves one trips a canary instead.

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
