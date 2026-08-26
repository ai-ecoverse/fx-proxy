#!/usr/bin/env node
// Copies fx-core.wasm out of the installed libfx package into vendor/ so the
// bundler can embed it as a CompiledWasm module. libfx does not export the
// .wasm file as a package subpath, so it cannot be imported directly.
import { copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, "vendor");

const sources = ["fx-core.wasm"];

let libfxDir;
try {
  libfxDir = dirname(require.resolve("libfx/wasm"));
} catch {
  console.error("[vendor-wasm] libfx is not installed yet; skipping");
  process.exit(0);
}

await mkdir(vendor, { recursive: true });
for (const name of sources) {
  const from = join(libfxDir, name);
  const to = join(vendor, name);
  await copyFile(from, to);
  const { size } = await stat(to);
  console.log(`[vendor-wasm] ${name} -> vendor/${name} (${(size / 1024 / 1024).toFixed(2)} MiB)`);
}
