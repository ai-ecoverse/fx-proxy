# fx-proxy on Fastly Compute

The same proxy, the same fx-core, as **one wasm module with one linear
memory** — no JavaScript anywhere in the deployment.

| | |
| --- | --- |
| service | `rVBzWXbUWCmGFQ9sUAGvqQ` |
| host | `https://eagerly-witty-burro.edgecompute.app` |
| package | `dist/fastly/main.wasm`, ~2.5 MB |

```sh
npm run build:fastly     # link the three modules into one
npm run serve:fastly     # Viceroy, locally
npm run deploy:fastly    # to the service in fastly.toml
```

## Why the Cloudflare build cannot be deployed here

Fastly's JavaScript runtime **has no `WebAssembly` object at all**.
`"WebAssembly" in globalThis` is `false`, so the identifier is undeclared
rather than undefined and even `WebAssembly?.x` throws. Both existing host
layers — the original JS one and the Hot Glue build's ~250-line
`src/index.js` shim — call `WebAssembly.instantiate` and JSPI, so neither
runs. Verified under Viceroy and again at the edge.

Three more platform facts shape the port. Each was measured, not assumed;
two of them differ between Viceroy and production, so **Viceroy alone is
not evidence**.

| | |
| --- | --- |
| memories per module | exactly one — a second fails with *"memory count too high at 2"* |
| exception handling | **not in production.** `try_table`/`throw` runs under Viceroy but activation fails with `xqd-codegen failed` |
| dynamic backends | disabled on this account; `allowDynamicBackends(true)` succeeds and the fetch still fails |

## What replaces JSPI: nothing

This is the part worth keeping. The Cloudflare build exists in the shape it
does because fx's agent loop is synchronous and the network is not, so
every model call unwinds a JSPI suspension through two wasm modules — and
`docs/runtime-notes.md` measures the cost: one suspension per token, a
median +440 ms of wall time against the JS host.

Fastly's hostcalls are **synchronous**. `fastly_http_req::send` blocks and
returns the response handles. fx's loop blocks on it exactly where it used
to suspend, so the entire stack-switching problem disappears. The property
that made this hard on Cloudflare is the one Fastly gives away.

## The link

Fastly runs one module per service and offers no nested instantiation, so
`scripts/link.mjs` links ahead of time instead:

```
vendor/fx-core.wasm ──┐
                      ├─ wasm-merge ─▶ dist/fastly/main.wasm
worker-fastly.wasm ───┤                 one module, one memory
glue.wasm ────────────┘
```

The same step builds the Cloudflare worker from `src-hma/worker.hma`. That
platform does not force the arrangement — it has both `WebAssembly` and JSPI —
but it is better off with it, so the two deployments now differ only in
whether the host can block.

- **`worker-fastly.wasm`** — the supervisor, from `src-hma/`. It shares
  `worker-core.hma` with the Cloudflare entry; only the host layer differs
  (`fastly.hma` against `fastly_http_*`, where Cloudflare imports nine
  suspending `host.*` functions from JavaScript).
- **`glue.wasm`** — the i64 seam, from `src-hma/fx-seam.hma`. fx-core's WASI
  imports carry i64 parameters and the Hot Glue assembler types every implicit
  signature i32, so nine adapters drop those arguments — the same `FX_IMPORTS`
  table the JS shim used, and every dropped argument is unused or stubbed in
  the gate behind it. Fastly has no clock hostcall either, so `now_seconds`
  lives here too, over WASI's i64 `clock_time_get`. Explicit `(type …)` is
  viral per module, which is exactly why the seam *is* a module: the virality
  stops at its edge and the supervisor stays in the implicit dialect.
- **`fx-core.wasm`** — unmodified except for the names in its import and
  export sections, rewritten in place (a wat2wasm round-trip re-encodes the
  module and this wabt emits "compact imports").

### Fusing the memories

`wasm-merge` will not fuse two memories; it emits multi-memory, which
Fastly rejects. The trick is to make the supervisor **import** its memory:

```wat
(import "fxcore" "memory" (memory 261))
```

The Hot Glue assembler supports that directly, so the link resolves it
against fx-core's exported memory and one memory comes out.

The layouts do not collide — and since nothing in the wasm enforces that,
it is guarded rather than trusted (see *The borders are guarded* below):

```
0 ──────────── 4 MB ─────────────── 16 MB ── 16.27 MB ── 17.1 MB ────▶
│ supervisor    │                    │ fx data │ slack  │ fx heap
│ (64 pages)    │  ← fx stack grows down from 16 MB      (memory.grow)
```

fx-core keeps a 16 MB stack growing *down* from 16 MB, its data at 16 MB,
and takes its heap from the single `memory.grow` it performs — which lands
above the 261 initial pages. The supervisor's 4 MB sits at the deep end of
fx's stack, which a 12 MB-shallower stack never reaches.

### Unwinding without unwinding

fx stops by calling `proc_exit`, and `g_proc_exit` traps deliberately to
unwind the agent loop. On Cloudflare JSPI turned that trap into a rejected
promise the shim caught, and `$fx-drive` resumed. In pure wasm a trap is
not catchable, and production has no exception handling.

What production *does* do — verified, with a 200 and the right body — is
**deliver a response that was handed to `send_downstream` before the guest
died**. So the request is finished on the way out rather than after:
`g_proc_exit` calls `$on-fx-exit`, which runs `$fx-drive-tail`, assembles
the Responses object through `$fx-final`, commits it, and only then lets
the trap happen. `$fx-final` was split out of `$handle-responses` for
exactly this reason; the Cloudflare path calls it in the ordinary place and
its `$on-fx-exit` is empty.

## Tool surface

Fastly resolves origins through **named backends** declared on the service,
and dynamic backends are disabled here, so the reachable set is fixed at
deploy time. One backend covers everything the default configuration needs:

| backend | origin | serves |
| --- | --- | --- |
| `gw` | `ai-gateway.vercel.sh` | fx's model calls, and `web_search` — with `SEARCH_PROVIDER=perplexity` search is a gateway server-side tool, so it shares the host |

`web_fetch` and the two AEM knowledge-base tools need an arbitrary origin
and are therefore **not advertised** in this build (`web-fetch-tool?` /
`kb-tools?` in `worker-fastly.hma`). The model is never shown a tool that
could only fail. Restoring them means asking Fastly to enable dynamic
backends on the account.

Configuration that Cloudflare passes as `vars` in the request frame's env
block is compiled in, since Fastly has no per-request environment — see the
`fst-*` macros in `worker-fastly.hma`.

## Toolchain

Hot Glue arrives as `@ai-ecoverse/hot-glue`, an ordinary devDependency, and
nothing is vendored: since 0.3.0 the package ships its own compiled organs, so
the whole path from `.hma` to a wasm binary runs from Node without reaching the
network.

The link step adds exactly one external tool, used only for the Fastly target:
binaryen's `wasm-merge` (`brew install binaryen`). The seam was generated WAT
and needed wabt's `wat2wasm` too, until it became `src-hma/fx-seam.hma` and the
assembler could build it like everything else.

## The borders are guarded

This is pattern D in Hot Glue's [wilderness-memory][wm] doctrine — one module,
one memory, on purpose — and it is the pattern where the platform gives you no
protection at all. Two hazards are real here, and both used to be silent:

- the supervisor's arena grows up from 131072 while fx-core's stack falls
  toward it from 16 MB, and nothing in the wasm enforces the gap;
- the glue libraries' state blocks sit in bands that a stray write walks
  straight out of.

`src-hma/glue-mem.hma` derives every band from `glue-alloc.hma`'s `(take …)`
rather than pinning addresses by hand, and takes each one *guarded*, so a band
ends in a four-byte sentinel. `worker-fastly.hma` posts one more at 4 MB — the
arena's measured ceiling — which catches either side crossing. `$handle` arms
them; `$fx-drive-tail` checks them, which is the moment after fx-core has had
the run of the address space, and `$fst-send-frame` checks again before
anything goes on the wire. `test-hma/canary-trap.hma` writes one word past a
band and must die at the tripwire.

[wm]: https://github.com/ai-ecoverse/hot-glue/blob/main/docs/wilderness-memory.md
