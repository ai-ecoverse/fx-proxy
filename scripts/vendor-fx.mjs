#!/usr/bin/env node
// Puts fx-core.wasm and the fx host layer (fx-sdk.js) in vendor/, where the
// bundler embeds the wasm as a CompiledWasm module and wrangler's alias points
// `libfx/wasm` at the vendored SDK. Sources, in order:
//
//   1. $FX_SRC or ~/Developer/vercel-labs/fx   a local fx checkout that is built
//   2. node_modules/libfx                      the published artifact
//
// Only the checkout supports host-declared tools: published fx-core advertises
// an empty tool set on wasm, and published fx-sdk.js has no `tools` option.
// See docs/runtime-notes.md.
import { access, copyFile, mkdir, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const vendor = join(root, "vendor");
const checkout = process.env.FX_SRC ?? join(homedir(), "Developer/vercel-labs/fx");

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function resolveSource() {
  const wasm = process.env.FX_CORE_WASM ?? join(checkout, "zig-out/bin/fx-core.wasm");
  const sdk = join(checkout, "sdk/fx-sdk.js");
  if ((await exists(wasm)) && (await exists(sdk))) {
    return { wasm, sdk, kind: `checkout ${checkout}`, hostTools: true };
  }

  try {
    const libfx = dirname(require.resolve("libfx/wasm"));
    return {
      wasm: join(libfx, "fx-core.wasm"),
      sdk: join(libfx, "fx-sdk.js"),
      kind: "libfx (upstream)",
      hostTools: false,
    };
  } catch {
    return null;
  }
}

const source = await resolveSource();
if (!source) {
  console.error("[vendor-fx] no fx-core.wasm source found; skipping");
  process.exit(0);
}

await mkdir(vendor, { recursive: true });
await copyFile(source.wasm, join(vendor, "fx-core.wasm"));
await copyFile(source.sdk, join(vendor, "fx-sdk.js"));
const { size } = await stat(join(vendor, "fx-core.wasm"));
console.log(
  `[vendor-fx] ${source.kind} -> vendor/fx-core.wasm (${(size / 1024 / 1024).toFixed(2)} MiB) + vendor/fx-sdk.js`,
);
if (!source.hostTools) {
  console.warn(
    "[vendor-fx] warning: upstream fx has no host tool support; build the patched fx checkout to enable web_search",
  );
}
