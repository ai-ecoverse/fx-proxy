# Runtime notes

Findings from compiling this worker to a single Hot Glue wasm binary, kept for
the next traveler.

## The boundary

The wasm imports four functions (`host.fetch`, `host.emit`, `host.log`,
`host.stream_start`) and exports three (`memory`, `alloc`, `handle`). All
structured data crosses as length-prefixed byte frames (`src-hma/frame.hma`
documents the exact layout). Time and randomness ride in the request frame, so
the module never needs a clock or an entropy import — one request, one
instance, deterministic given its inputs.

JSPI is what closes the loop: in production `host.fetch` is a
`WebAssembly.Suspending` import and `handle` is wrapped with
`WebAssembly.promising`. In tests the same exports are called directly with
synchronous mocks — no JSPI, no flags, plain Node (`test/harness.ts`).
Verified end-to-end under workerd via `wrangler dev`: suspension, real HTTPS
egress, and SSE streaming all work.

## The toolchain

- Stage 0 (`hotglue/bootstrap.ts`) runs under Node's native type-stripping;
  the `.js`→`.ts` import specifier was adjusted when vendoring.
- `hotglue/as.wasm` is the self-hosted assembler, prebuilt in the hot-glue
  repo (`npm run bootstrap` there reproduces it byte-identically). It runs
  here as a WASI reactor under `node:wasi`: stdin is the WAT, stdout the
  binary.
- Two stage-0 changes made here, worth upstreaming to hot-glue:
  1. `(use …)` resolves at any depth, not only at the top level, so a
     `(module …)` form can splice library files of functions.
  2. `print()` memoizes each node's flat rendering in a `WeakMap`. The
     original recomputed it once per indentation level — quadratic; a
     50 KB module took minutes to print and now takes milliseconds.

## Memory discipline

- `0..31` scratch, `32..` the interned string pool (the lowerer pools every
  inline string literal; the build asserts the pool stays under 65536),
  `65536..` the runtime registers (`src-hma/slots.hma`), `131072..` a bump
  arena. There is no free: an instance serves one request and is discarded.
- The shim allocates the request frame *before* calling `handle`, so `alloc`
  self-initializes the heap pointer on first use and `handle` must never
  reset the arena.

## Language notes (writing large programs in the clj accent)

- Bare integers self-wrap in `i32.const` only inside accent macros; in plain
  WAT positions (`call` arguments especially) write `(num N)`.
- `while`'s `$break`/`$continue` labels are hygienic — a hand-written
  `(br $break)` inside one silently miscompiles to the wrong target. Use
  flags or `(return)` to leave loops early.
- Multi-statement branches inside the value-producing `cond` are written as
  `(splice stmt… (num 0))` with a final `(drop)` after the `cond`.
- A string literal in expression position becomes *two* operands (ptr, len);
  every string-taking function's arity is written with that in mind.
