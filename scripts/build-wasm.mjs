#!/usr/bin/env node
/**
 * Builds dist/worker.wasm from the Hot Glue sources in src-hma/.
 *
 * Two stages:
 *   1. Hot Glue's stage 0, from @ai-ecoverse/hot-glue, expands
 *      src-hma/worker.hma to WAT.
 *   2. hotglue/as.wasm (the self-hosted Hot Glue assembler, itself a wasm
 *      binary assembled by its own source) assembles that WAT under
 *      node:wasi. It stays vendored because it is the one artifact the
 *      package does not publish — the libraries and the expander come
 *      from npm now. No external toolchain, no network.
 */
import { mkdirSync, openSync, readFileSync, writeFileSync, closeSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WASI } from 'node:wasi';
import { loadSource, compile } from '@ai-ecoverse/hot-glue';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
// The Hot Glue libraries ship inside the package, beside its bootstrap.
// src-hma comes first so this program's own glue-mem.hma shadows the
// one the toolchain would otherwise answer with.
const hotglue = dirname(fileURLToPath(import.meta.resolve('@ai-ecoverse/hot-glue')));
const entry = process.argv[2] ?? join(root, 'src-hma', 'worker.hma');
const outPath = process.argv[3] ?? join(root, 'dist', 'worker.wasm');

// Stage 0: .hma -> WAT, from @ai-ecoverse/hot-glue. (use ...) resolves
// against the entry's directory, then src-hma, then the libraries the
// package ships.
const src = loadSource([entry], [join(root, 'src-hma'), hotglue]);
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
