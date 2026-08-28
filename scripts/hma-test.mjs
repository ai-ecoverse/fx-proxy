#!/usr/bin/env node
/**
 * Runs a Hot Glue test suite: expand, assemble, execute, report.
 *
 * The suite is its own verdict. glue-test.hma prints a transcript and
 * exits nonzero when an assertion failed, so this script only has to
 * carry the bytes and hand back what the module said. Same two stages as
 * scripts/build-wasm.mjs — the vendored stage 0 for .hma -> WAT, the
 * vendored as.wasm for WAT -> binary — and then a third: run the result
 * as a WASI command under node:wasi. No wasmtime, no network.
 *
 *   node scripts/hma-test.mjs test-hma/json.hma
 *   node scripts/hma-test.mjs            # every test-hma/*.hma
 */
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { loadSource, compile } from '../hotglue/bootstrap.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const suiteDir = join(root, 'test-hma');
// src-hma and hotglue come first on purpose. A suite is a module, not a
// library, and a suite file named json.hma would otherwise answer every
// (use json.hma) in the tree — splicing a whole module where a fragment
// belongs. Suites are named *-test.hma for the same reason.
const searchPath = [join(root, 'src-hma'), join(root, 'hotglue'), suiteDir];

/** WAT in, module bytes out, through the self-hosted assembler. */
function assemble(watPath, wasmPath) {
  const stdin = openSync(watPath, 'r');
  const stdout = openSync(wasmPath, 'w');
  const wasi = new WASI({ version: 'preview1', stdin, stdout, stderr: 2 });
  const asBytes = readFileSync(join(root, 'hotglue', 'as.wasm'));
  return WebAssembly.instantiate(asBytes, wasi.getImportObject()).then(({ instance }) => {
    wasi.initialize(instance);
    instance.exports.run();
    closeSync(stdin);
    closeSync(stdout);
  });
}

/** Run a WASI command, returning its stdout and exit code. */
async function run(wasmPath, outPath) {
  const stdout = openSync(outPath, 'w');
  const wasi = new WASI({ version: 'preview1', stdout, stderr: stdout, returnOnExit: true });
  const bytes = readFileSync(wasmPath);
  const { instance } = await WebAssembly.instantiate(bytes, wasi.getImportObject());
  const code = wasi.start(instance);
  closeSync(stdout);
  return { code, out: readFileSync(outPath, 'utf8') };
}

/**
 * The assembler reports an unknown callee as "func?" on stderr and then
 * traps, which does not say which name went missing. Name them here.
 */
function unresolved(wat) {
  const defined = new Set(
    [...wat.matchAll(/\(func (\$[^\s)]+)/g)].map((m) => m[1]),
  );
  for (const m of wat.matchAll(/\(import[^)]*\(func (\$[^\s)]+)/g)) defined.add(m[1]);
  const missing = new Set();
  for (const m of wat.matchAll(/\(call (\$[^\s)]+)/g)) {
    if (!defined.has(m[1])) missing.add(m[1]);
  }
  return [...missing];
}

async function suite(entry) {
  const work = mkdtempSync(join(tmpdir(), 'fxproxy-hma-'));
  const name = basename(entry, '.hma');
  const watPath = join(work, `${name}.wat`);
  const wasmPath = join(work, `${name}.wasm`);
  const wat = compile(loadSource([entry], searchPath));
  const missing = unresolved(wat);
  if (missing.length) {
    throw new Error(
      `${entry}: ${missing.length} unresolved call(s): ${missing.join(', ')}\n` +
        '  A missing (use …) layer, or a suite shadowing a library of the same name.',
    );
  }
  writeFileSync(watPath, wat);
  await assemble(watPath, wasmPath);
  return run(wasmPath, join(work, `${name}.txt`));
}

const args = process.argv.slice(2);
let entries = args;
if (!entries.length) {
  mkdirSync(suiteDir, { recursive: true });
  entries = readdirSync(suiteDir)
    .filter((f) => f.endsWith('-test.hma'))
    .map((f) => join(suiteDir, f));
}
if (!entries.length) {
  console.error('no suites in test-hma/');
  process.exit(1);
}

let failed = 0;
for (const entry of entries) {
  const { code, out } = await suite(entry);
  process.stdout.write(out);
  if (code !== 0) {
    failed++;
    console.error(`FAILED ${entry} (exit ${code})`);
  }
}
process.exit(failed ? 1 : 0);
