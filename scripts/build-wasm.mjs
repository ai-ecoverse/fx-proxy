#!/usr/bin/env node
/**
 * Builds dist/worker.wasm from the Hot Glue sources in src-hma/.
 *
 * One call. @ai-ecoverse/hot-glue ships its own compiled organs — the
 * expander, the assembler, the compiler that drives them — so `compile`
 * goes from .hma to a wasm binary without this script arranging the
 * middle. It used to: stage 0 for the WAT, then the self-hosted
 * assembler run as a WASI reactor over stdin and stdout, from a copy of
 * as.wasm vendored here because the package did not publish one. That
 * plumbing existed only because the binary was missing, and both are
 * gone now.
 *
 * No external toolchain and no network: the organs are wasm, driven
 * from Node.
 */
import { mkdirSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compile } from '@ai-ecoverse/hot-glue';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const entry = process.argv[2] ?? join(root, 'src-hma', 'worker.hma');
const outPath = process.argv[3] ?? join(root, 'dist', 'worker.wasm');

// src-hma is on the lookup path so this program's own glue-mem.hma
// shadows the library of that name; the toolchain's own sources answer
// everything else.
const { wat, bin } = compile(readFileSync(entry), { dirs: [join(root, 'src-hma')] });

mkdirSync(dirname(outPath), { recursive: true });
const watPath = outPath.replace(/\.wasm$/, '.wat');
writeFileSync(watPath, wat);
writeFileSync(outPath, bin);

// Both halves come back as bytes, deliberately — a decode is lossy in a
// way this project would notice. The pool check reads the text, so it
// asks for a string here and nowhere else.
const watText = Buffer.from(wat).toString();

// The lowerer pools strings from offset 32; the runtime's registers
// start at 65536, so the pool must stay below that.
const dataAts = [...watText.matchAll(/\(data \(i32\.const (\d+)\) "((?:[^"\\]|\\.)*)"/g)];
for (const [, at, str] of dataAts) {
  const len = str.replace(/\\../g, '.').length;
  if (Number(at) + len > 65536) throw new Error(`string pool overflows into registers at ${at}`);
}

const size = statSync(outPath).size;
if (size < 8) throw new Error('assembler produced no output');
// Sanity: the module must parse.
new WebAssembly.Module(readFileSync(outPath));
console.log(`built ${outPath} (${size} bytes) from ${entry}`);
