#!/usr/bin/env node
/**
 * Links one entry module, the i64 seam and fx-core into a single wasm
 * module with a single linear memory.
 *
 *   node scripts/link.mjs src-hma/worker.hma dist/worker.wasm
 *   node scripts/link.mjs src-hma/worker-fastly.hma dist/fastly/main.wasm
 *
 * Fastly forced this: it runs exactly one module per service and offers
 * no nested instantiation. Cloudflare does not force it — it has both
 * WebAssembly and JSPI — but the arrangement is better there too, so
 * both deployments are built the same way. What it removes from the
 * Cloudflare shim is the whole of the two-instance apparatus: binding
 * fx's fifty-one imports, the trampolines that drop their i64
 * arguments, the second instantiation, and the two byte-copies that
 * mediated between two memories.
 *
 *   <entry>.wasm        the supervisor, built by Hot Glue. Imports its
 *                       memory from fx-core, so the link fuses the two
 *                       address spaces instead of producing a second
 *                       memory — which Fastly rejects outright, and
 *                       which Cloudflare only tolerated.
 *   glue.wasm           the i64 seam, from src-hma/fx-seam.hma. fx-core's
 *                       WASI imports carry i64 parameters and the Hot Glue
 *                       assembler types every implicit signature i32, so
 *                       nine adapters drop those arguments (each is unused
 *                       or stubbed in the gate behind it). Explicit types
 *                       are viral per module, which is why the seam is a
 *                       module. The wall clock lives here too.
 *   fx-core.wasm        Vercel's fx, unmodified apart from the names in
 *                       its import and export sections.
 *
 * The layouts do not collide. fx-core keeps a 16 MB stack growing *down*
 * from 16 MB, its data at 16 MB, and takes its heap from the single
 * memory.grow it performs, which lands above the 261 initial pages. The
 * supervisor lives in 0..4 MB — the deep end of fx's stack, which a
 * 12 MB-shallower stack never reaches.
 *
 * Needs binaryen's wasm-merge on PATH. Everything else — the seam
 * included, now that it is Hot Glue rather than generated WAT — comes
 * from @ai-ecoverse/hot-glue and runs offline.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const [entryArg, outArg] = process.argv.slice(2);
if (!entryArg || !outArg) {
  console.error('usage: node scripts/link.mjs <entry.hma> <out.wasm>');
  process.exit(1);
}
const entry = join(root, entryArg);
const target = join(root, outArg);
const out = dirname(target);
mkdirSync(out, { recursive: true });
const stem = basename(target, '.wasm');

// fx-core's imports whose signature carries an i64, and the i32 argument
// positions the gate behind them actually takes. Same table as the
// Cloudflare shim's FX_IMPORTS: every dropped argument is unused or
// stubbed, which is why dropping them is sound.
// fx-core's imports whose signature carries an i64. What each adapter
// does with those arguments — every one is unused or stubbed in the
// gate behind it — is written out in src-hma/fx-seam.hma; here we only
// need to know which imports go to the seam rather than straight to a
// gate.
const I64_ADAPTERS = new Set([
  'clock_time_get',
  'fd_seek',
  'fd_filestat_set_size',
  'fd_filestat_set_times',
  'fd_pread',
  'fd_pwrite',
  'fd_readdir',
  'path_filestat_set_times',
  'path_open',
]);

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

// --------------------------------------------------------------- build

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    const detail = error.stderr?.toString().trim() || error.message;
    throw new Error(`${cmd} failed: ${detail}`);
  }
}

// 1. the supervisor, straight from the Hot Glue toolchain
const supervisor = join(out, `${stem}-sup.wasm`);
run(process.execPath, [join(root, 'scripts', 'build-wasm.mjs'), entry, supervisor]);

// 2. the seam, from the same toolchain as the supervisor
const seam = join(out, `${stem}-seam.wasm`);
run(process.execPath, [
  join(root, 'scripts', 'build-wasm.mjs'),
  join(root, 'src-hma', 'fx-seam.hma'),
  seam,
]);

// 3. fx-core, with its imports pointed at the gates and `_start` renamed
//    out of the way of the supervisor's own.
const fxCore = readFileSync(join(root, 'vendor', 'fx-core.wasm'));
const fxPatched = patch(fxCore, {
  imports: (mod, field) =>
    I64_ADAPTERS.has(field) ? ['glue', `a_${field}`] : ['sup', `g_${field}`],
  exports: (field) => (field === '_start' ? 'fx_core_start' : field),
});
const fxLinked = join(out, `${stem}-fx.wasm`);
writeFileSync(fxLinked, fxPatched);

// 4. link. fx-core goes first so its memory export is present before the
//    other two import it.
run('wasm-merge', [
  fxLinked, 'fxcore',
  supervisor, 'sup',
  seam, 'glue',
  '-o', target,
  // fx-core is Zig: it uses bulk memory, saturating float-to-int and
  // sign extension. These only tell the validator what to allow; the
  // merge introduces nothing that was not already in the inputs.
  '--enable-bulk-memory',
  '--enable-nontrapping-float-to-int',
  '--enable-sign-ext',
  '--enable-mutable-globals',
]);

const size = readFileSync(target).length;
console.log(`linked ${outArg} (${size} bytes) from ${entryArg}`);
