import fxCoreWasm from "../vendor/fx-core.wasm";
import { resolveConfig } from "./config.js";
import type { Bindings } from "./config.js";
import { route } from "./router.js";

export default {
  async fetch(request: Request, env: Bindings): Promise<Response> {
    let config;
    try {
      config = resolveConfig(env);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return new Response(
        JSON.stringify({ error: { message, type: "server_error", param: null, code: null } }),
        { status: 500, headers: { "content-type": "application/json" } },
      );
    }
    return route(request, {
      wasm: fxCoreWasm,
      config,
      runtime: "cloudflare-workers",
      log: (message) => console.log(message),
    });
  },
} satisfies ExportedHandler<Bindings>;
