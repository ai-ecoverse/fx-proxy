#!/usr/bin/env node
/**
 * Builds dist/fastly/main.wasm: the whole proxy, fx-core included, as one
 * Fastly Compute module with one linear memory.
 *
 * Fastly runs exactly one wasm module per service and has no nested
 * instantiation, so the two-instance arrangement the Cloudflare build uses
 * (a JS shim holding both memories) has no equivalent here. Instead the
 * three modules are linked ahead of time:
 *
 *   worker-fastly.wasm  the supervisor, built by Hot Glue. Imports its
 *                       memory from fx-core, so the link fuses the two
 *                       address spaces instead of producing a second
 *                       memory — which Fastly rejects outright.
 *   glue.wasm           the i64 seam. fx-core's WASI imports carry i64
 *                       parameters and the Hot Glue assembler types every
 *                       implicit signature i32, so nine adapters drop
 *                       those arguments (each is unused or stubbed in the
 *                       gate behind it). The wall clock lives here too,
 *                       for the same reason.
 *   fx-core.wasm        Vercel's fx, unmodified apart from the names in
 *                       its import and export sections.
 *
 * The layouts do not collide. fx-core keeps a 16 MB stack growing *down*
 * from 16 MB, its data at 16 MB, and takes its heap from the single
 * memory.grow it performs, which lands above the 261 initial pages. The
 * supervisor lives in 0..4 MB — the deep end of fx's stack, which a
 * 12 MB-shallower stack never reaches.
 *
 * Needs binaryen's wasm-merge and wabt's wat2wasm on PATH. Everything
 * else, including the Hot Glue toolchain, is vendored and offline.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, 'dist', 'fastly');
mkdirSync(out, { recursive: true });

// fx-core's imports whose signature carries an i64, and the i32 argument
// positions the gate behind them actually takes. Same table as the
// Cloudflare shim's FX_IMPORTS: every dropped argument is unused or
// stubbed, which is why dropping them is sound.
const I64_ADAPTERS = {
  clock_time_get: { params: ['i32', 'i64', 'i32'], keep: [0, 2] },
  fd_seek: { params: ['i32', 'i64', 'i32', 'i32'], keep: [0, 2, 3] },
  fd_filestat_set_size: { params: ['i32', 'i64'], keep: [0] },
  fd_filestat_set_times: { params: ['i32', 'i64', 'i64', 'i32'], keep: [0, 3] },
  fd_pread: { params: ['i32', 'i32', 'i32', 'i64', 'i32'], keep: [0, 1, 2, 4] },
  fd_pwrite: { params: ['i32', 'i32', 'i32', 'i64', 'i32'], keep: [0, 1, 2, 4] },
  fd_readdir: { params: ['i32', 'i32', 'i32', 'i64', 'i32'], keep: [0, 1, 2, 4] },
  path_filestat_set_times: {
    params: ['i32', 'i32', 'i32', 'i32', 'i64', 'i64', 'i32'],
    keep: [0, 1, 2, 3, 6],
  },
  path_open: {
    params: ['i32', 'i32', 'i32', 'i32', 'i32', 'i64', 'i64', 'i32', 'i32'],
    keep: [0, 1, 2, 3, 4, 7, 8],
  },
};

// 8 bytes of scratch for the clock, inside the band rt.hma reserves.
// WASI writes an i64 here, so it has to be 8-byte aligned.
const CLOCK_SCRATCH = 66656;

// ------------------------------------------------------------ wasm bits
// Just enough of the binary format to rename imports and exports in place.
// A wat2wasm round-trip would be shorter but re-encodes the whole module,
// and this wabt emits "compact imports" that Fastly's compiler has no
// reason to accept.

function readU32(buf, at) {
  let result = 0, shift = 0, pos = at;
  for (;;) {
    const byte = buf[pos++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, pos];
}

function writeU32(value) {
  const bytes = [];
  let v = value >>> 0;
  do {
    let byte = v & 0x7f;
    v >>>= 7;
    if (v !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (v !== 0);
  return Buffer.from(bytes);
}

function name(buf, at) {
  const [len, start] = readU32(buf, at);
  return [buf.subarray(start, start + len).toString('utf8'), start + len];
}

function encodeName(str) {
  const bytes = Buffer.from(str, 'utf8');
  return Buffer.concat([writeU32(bytes.length), bytes]);
}

/** Split a module into [{id, body}], preserving order and bytes. */
function sections(buf) {
  const list = [];
  let at = 8;
  while (at < buf.length) {
    const id = buf[at];
    const [size, start] = readU32(buf, at + 1);
    list.push({ id, body: buf.subarray(start, start + size) });
    at = start + size;
  }
  return list;
}

function assemble(list) {
  const parts = [buf8(), ...list.flatMap((s) => [Buffer.from([s.id]), writeU32(s.body.length), s.body])];
  return Buffer.concat(parts);
}

function buf8() {
  return Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]);
}

/** Rewrite every import's (module, field) through `rename`. */
function renameImports(body, rename) {
  const [count, start] = readU32(body, 0);
  let at = start;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const [mod, afterMod] = name(body, at);
    const [field, afterField] = name(body, afterMod);
    const kind = body[afterField];
    let end = afterField + 1;
    if (kind === 0x00) [, end] = readU32(body, end);              // func: typeidx
    else if (kind === 0x01) { end += 1; end = limitsEnd(body, end); } // table
    else if (kind === 0x02) end = limitsEnd(body, end);            // memory
    else if (kind === 0x03) end += 2;                              // global
    else throw new Error(`unknown import kind ${kind}`);
    const [newMod, newField] = rename(mod, field, kind);
    entries.push(
      Buffer.concat([
        encodeName(newMod),
        encodeName(newField),
        body.subarray(afterField, end),
      ]),
    );
    at = end;
  }
  return Buffer.concat([writeU32(count), ...entries]);
}

function limitsEnd(body, at) {
  const flags = body[at];
  let [, end] = readU32(body, at + 1);
  if (flags & 0x01) [, end] = readU32(body, end);
  return end;
}

/** Rewrite export names through `rename`; a null name drops the export. */
function renameExports(body, rename) {
  const [count, start] = readU32(body, 0);
  let at = start;
  const entries = [];
  for (let i = 0; i < count; i++) {
    const [field, afterField] = name(body, at);
    const kind = body[afterField];
    const [, end] = readU32(body, afterField + 1);
    const renamed = rename(field, kind);
    if (renamed !== null) {
      entries.push(Buffer.concat([encodeName(renamed), body.subarray(afterField, end)]));
    }
    at = end;
  }
  return Buffer.concat([writeU32(entries.length), ...entries]);
}

function patch(buf, { imports, exports }) {
  const list = sections(buf).map((s) => {
    if (s.id === 2 && imports) return { id: s.id, body: renameImports(s.body, imports) };
    if (s.id === 7 && exports) return { id: s.id, body: renameExports(s.body, exports) };
    return s;
  });
  return assemble(list);
}

// ----------------------------------------------------------- the glue

function glueWat() {
  const lines = [
    ';; glue.wat — generated by scripts/build-fastly.mjs, do not edit.',
    ';;',
    ";; The i64 seam between fx-core and the Hot Glue supervisor. fx's WASI",
    ';; imports carry i64 parameters; the assembler types every implicit',
    ';; signature i32 and refuses anything else, so the arguments are dropped',
    ';; here instead. Each one is unused or stubbed in the gate behind it.',
    '(module',
    '  (import "fxcore" "memory" (memory 261))',
    '  (import "wasi_snapshot_preview1" "clock_time_get"',
    '    (func $wasi_clock (param i32 i64 i32) (result i32)))',
  ];
  for (const fn of Object.keys(I64_ADAPTERS)) {
    const arity = I64_ADAPTERS[fn].keep.length;
    lines.push(
      `  (import "sup" "g_${fn}" (func $g_${fn} (param${' i32'.repeat(arity)}) (result i32)))`,
    );
  }
  lines.push(
    '',
    '  ;; Fastly has no clock hostcall of its own, so the wall clock comes',
    "  ;; from WASI — whose i64 is exactly what the assembler cannot spell.",
    '  (func (export "now_seconds") (result i32)',
    `    (drop (call $wasi_clock (i32.const 0) (i64.const 1000000) (i32.const ${CLOCK_SCRATCH})))`,
    `    (i32.wrap_i64 (i64.div_u (i64.load (i32.const ${CLOCK_SCRATCH})) (i64.const 1000000000))))`,
    '',
  );
  for (const [fn, { params, keep }] of Object.entries(I64_ADAPTERS)) {
    const decl = params.map((t, i) => `(param $a${i} ${t})`).join(' ');
    const args = keep.map((i) => `(local.get $a${i})`).join(' ');
    lines.push(`  (func (export "a_${fn}") ${decl} (result i32)`);
    lines.push(`    (call $g_${fn} ${args}))`);
  }
  lines.push(')');
  return lines.join('\n') + '\n';
}

// --------------------------------------------------------------- build

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`${cmd} failed: ${detail}`);
  }
}

// 1. the supervisor, straight from the vendored Hot Glue toolchain
run(process.execPath, [
  join(root, 'scripts', 'build-wasm.mjs'),
  join(root, 'src-hma', 'worker-fastly.hma'),
  join(out, 'worker-fastly.wasm'),
]);

// 2. the glue
const watPath = join(out, 'glue.wat');
writeFileSync(watPath, glueWat());
run('wat2wasm', [watPath, '-o', join(out, 'glue.wasm')]);

// 3. fx-core, with its imports pointed at the gates and `_start` renamed
//    out of the way of the supervisor's own.
const fxCore = readFileSync(join(root, 'vendor', 'fx-core.wasm'));
const fxPatched = patch(fxCore, {
  imports: (mod, field) =>
    field in I64_ADAPTERS ? ['glue', `a_${field}`] : ['sup', `g_${field}`],
  exports: (field) => (field === '_start' ? 'fx_core_start' : field),
});
writeFileSync(join(out, 'fx-core-linked.wasm'), fxPatched);

// 4. link. fx-core goes first so its memory export is present before the
//    other two import it.
run('wasm-merge', [
  join(out, 'fx-core-linked.wasm'), 'fxcore',
  join(out, 'worker-fastly.wasm'), 'sup',
  join(out, 'glue.wasm'), 'glue',
  '-o', join(out, 'main.wasm'),
  // fx-core is Zig: it uses bulk memory, saturating float-to-int and
  // sign extension. These only tell the validator what to allow; the
  // merge introduces nothing that was not already in the inputs.
  '--enable-bulk-memory',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-mutable-globals',
]);

const size = readFileSync(join(out, 'main.wasm')).length;
console.log(`built ${join(out, 'main.wasm')} (${size} bytes)`);
