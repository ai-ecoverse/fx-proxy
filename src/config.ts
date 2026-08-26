/** Runtime configuration, resolved once per request from platform bindings. */

export interface Bindings {
  /** Vercel AI Gateway credential fx uses for model inference. */
  AI_GATEWAY_API_KEY?: string;
  /** When set, clients must present this as `Authorization: Bearer <key>`. */
  PROXY_API_KEY?: string;
  DEFAULT_MODEL?: string;
  MAX_AGENT_STEPS?: string;
  SEARCH_PROVIDER?: string;
  SEARCH_API_KEY?: string;
  /** Overrides the gateway base for local development only. */
  FX_GATEWAY_BASE_URL?: string;
}

export type SearchProviderName = "ddg" | "brave" | "tavily" | "exa" | "serper";

const searchProviders: SearchProviderName[] = ["ddg", "brave", "tavily", "exa", "serper"];

export interface Config {
  defaultModel: string;
  maxAgentSteps: number;
  proxyApiKey?: string;
  gatewayApiKey?: string;
  gatewayBaseUrl?: string;
  search: {
    provider: SearchProviderName;
    apiKey?: string;
  };
}

export class ConfigError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.status = status;
  }
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function resolveConfig(bindings: Bindings): Config {
  const provider = (bindings.SEARCH_PROVIDER ?? "ddg") as SearchProviderName;
  if (!searchProviders.includes(provider)) {
    throw new ConfigError(`unsupported SEARCH_PROVIDER: ${provider}`);
  }
  return {
    defaultModel: bindings.DEFAULT_MODEL ?? "openai/gpt-5",
    maxAgentSteps: parsePositiveInt(bindings.MAX_AGENT_STEPS, 24),
    proxyApiKey: bindings.PROXY_API_KEY || undefined,
    gatewayApiKey: bindings.AI_GATEWAY_API_KEY || undefined,
    gatewayBaseUrl: bindings.FX_GATEWAY_BASE_URL || undefined,
    search: {
      provider,
      apiKey: bindings.SEARCH_API_KEY || undefined,
    },
  };
}

/**
 * Resolves the credential fx uses to reach the model.
 *
 * With `PROXY_API_KEY` set the proxy authenticates the caller and uses its own
 * gateway credential. Without it the caller's bearer token is forwarded, so the
 * proxy stores no credentials of its own.
 */
export function resolveCredentials(
  config: Config,
  authorization: string | null,
): { gatewayApiKey: string } {
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();

  if (config.proxyApiKey) {
    if (bearer !== config.proxyApiKey) {
      throw new ConfigError("invalid API key provided", 401);
    }
    if (!config.gatewayApiKey) {
      throw new ConfigError("proxy is missing AI_GATEWAY_API_KEY", 500);
    }
    return { gatewayApiKey: config.gatewayApiKey };
  }

  const key = bearer || config.gatewayApiKey;
  if (!key) {
    throw new ConfigError(
      "missing credentials: send an AI Gateway key as `Authorization: Bearer <key>` or configure AI_GATEWAY_API_KEY",
      401,
    );
  }
  return { gatewayApiKey: key };
}
