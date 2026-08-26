#!/usr/bin/env node
// Puts fx-core.wasm in vendor/ so the bundler can embed it as a CompiledWasm
// module. Sources, in order:
//
//   1. $FX_CORE_WASM             explicit path to a built artifact
//   2. $FX_SRC/zig-out/bin/...   a local fx checkout that has been built
//   3. node_modules/libfx        the published artifact
//
// Only 1 and 2 can advertise tools: upstream fx-core advertises an empty tool
// set on wasm, so the published artifact runs the agent without web search.
// See docs/runtime-notes.md.
import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, "vendor");
const target = join(vendor, "fx-core.wasm");

const patchedCheckout = process.env.FX_SRC ?? join(homedir(), "Developer/vercel-labs/fx");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveSource() {
  if (process.env.FX_CORE_WASM) {
    if (!(await exists(process.env.FX_CORE_WASM))) {
      throw new Error(`FX_CORE_WASM does not exist: ${process.env.FX_CORE_WASM}`);
    }
    return { path: process.env.FX_CORE_WASM, kind: "patched", tools: true };
  }

  const built = join(patchedCheckout, "zig-out/bin/fx-core.wasm");
  if (await exists(built)) return { path: built, kind: `checkout ${patchedCheckout}`, tools: true };

  try {
    const libfx = dirname(require.resolve("libfx/wasm"));
    return { path: join(libfx, "fx-core.wasm"), kind: "libfx (upstream)", tools: false };
  } catch {
    return null;
  }
}

const source = await resolveSource();
if (!source) {
  console.error("[vendor-wasm] no fx-core.wasm source found; skipping");
  process.exit(0);
}

await mkdir(vendor, { recursive: true });
await copyFile(source.path, target);
const { size } = await stat(target);
console.log(
  `[vendor-wasm] ${source.kind} -> vendor/fx-core.wasm (${(size / 1024 / 1024).toFixed(2)} MiB)`,
);
if (!source.tools) {
  console.warn(
    "[vendor-wasm] warning: upstream fx-core advertises no tools on wasm; build the patched fx checkout to enable web_search",
  );
}
