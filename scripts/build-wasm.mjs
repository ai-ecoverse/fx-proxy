#!/usr/bin/env node
/**
 * Builds dist/worker.wasm from the Hot Glue sources in src-hma/.
 *
 * Two stages, both vendored under hotglue/:
 *   1. bootstrap.ts (Hot Glue stage 0) expands src-hma/worker.hma to WAT.
 *   2. as.wasm (the self-hosted Hot Glue assembler, itself a wasm binary
 *      assembled by its own source) assembles that WAT to dist/worker.wasm
 *      under node:wasi. No external toolchain, no network.
 */
import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { loadSource } from '../hotglue/bootstrap.ts';
import { compile } from '../hotglue/bootstrap.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = process.argv[2] ?? join(root, 'src-hma', 'worker.hma');
const outPath = process.argv[3] ?? join(root, 'dist', 'worker.wasm');

// Stage 0: .hma -> WAT. (use ...) resolves against the entry's directory
// and the vendored toolchain directory (clj.hma, prelude.hma).
const src = loadSource([entry], [join(root, 'src-hma'), join(root, 'hotglue')]);
const wat = compile(src);
mkdirSync(join(root, 'dist'), { recursive: true });
const watPath = outPath.replace(/\.wasm$/, '.wat');
writeFileSync(watPath, wat);

// Stage 1: WAT -> binary through the self-hosted assembler. as.wasm is a
// WASI reactor exporting `run`; stdin is the WAT, stdout the module.
const stdinPath = watPath;
const stdoutPath = outPath;
const stdin = openSync(stdinPath, 'r');
const stdout = openSync(stdoutPath, 'w');
const wasi = new WASI({ version: 'preview1', stdin, stdout, stderr: 2 });
const asBytes = readFileSync(join(root, 'hotglue', 'as.wasm'));
const { instance } = await WebAssembly.instantiate(asBytes, wasi.getImportObject());
wasi.initialize(instance);
instance.exports.run();
closeSync(stdin);
closeSync(stdout);

// The lowerer pools strings from offset 32; the runtime's registers
// start at 65536, so the pool must stay below that.
const dataAts = [...wat.matchAll(/\(data \(i32\.const (\d+)\) "((?:[^"\\]|\\.)*)"/g)];
for (const [, at, str] of dataAts) {
  const len = str.replace(/\\../g, '.').length;
  if (Number(at) + len > 65536) throw new Error(`string pool overflows into registers at ${at}`);
}

const size = statSync(outPath).size;
if (size < 8) throw new Error('assembler produced no output');
// Sanity: the module must parse.
new WebAssembly.Module(readFileSync(outPath));
console.log(`built ${outPath} (${size} bytes) from ${entry}`);
