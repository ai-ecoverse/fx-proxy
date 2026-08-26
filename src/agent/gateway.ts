import type { Config } from "../config.js";

const allowedHosts = new Set(["ai-gateway.vercel.sh"]);

export interface GatewayStats {
  requests: number;
  /** Upstream 401/403 responses; fx reports these as ordinary assistant text. */
  authFailures: number;
}

/**
 * Host `fetch` handed to the fx runtime. fx only reaches the network through
 * this function, so the allowlist is the proxy's egress boundary: model traffic
 * goes to the gateway, and every custom tool runs in the host instead.
 */
export function createGatewayFetch(
  config: Config,
  credentials: { gatewayApiKey: string },
  stats: GatewayStats,
): typeof fetch {
  const localBase = config.gatewayBaseUrl ? safeUrl(config.gatewayBaseUrl) : undefined;

  return async (input, init) => {
    const request = new Request(input as RequestInfo, init as RequestInit);
    const url = new URL(request.url);
    const permitted =
      allowedHosts.has(url.hostname) ||
      (localBase !== undefined && url.origin === localBase.origin);

    if (!permitted) {
      return new Response(
        JSON.stringify({
          error: {
            message: `fx-proxy blocked an outbound request to ${url.host}. The sandboxed runtime may only reach the model gateway.`,
            type: "egress_blocked",
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    }

    const headers = new Headers(request.headers);
    if (!headers.has("authorization")) {
      headers.set("authorization", `Bearer ${credentials.gatewayApiKey}`);
    }
    stats.requests += 1;
    const response = await fetch(new Request(request, { headers }));
    if (response.status === 401 || response.status === 403) stats.authFailures += 1;
    return response;
  };
}

function safeUrl(value: string): URL | undefined {
  try {
    return new URL(value);
  } catch {
    return undefined;
  }
}
