import { ConfigError } from "./config.js";
import type { Config } from "./config.js";
import { handleResponses, json } from "./responses/handler.js";
import { RequestError } from "./responses/request.js";

export interface RouterContext {
  wasm: WebAssembly.Module;
  config: Config;
  runtime: string;
  log?(message: string): void;
}

const corsHeaders: Record<string, string> = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers":
    "authorization, content-type, openai-beta, x-org, x-repo, x-ref, x-owner, x-site, x-aem-org, x-aem-repo, x-aem-ref",
  "access-control-max-age": "86400",
};

export async function route(request: Request, context: RouterContext): Promise<Response> {
  if (request.method === "OPTIONS") {
    return withCors(new Response(null, { status: 204 }));
  }

  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";

  try {
    if (path === "/" || path === "/health") {
      return withCors(
        json({
          service: "fx-proxy",
          agent: "fx",
          runtime: context.runtime,
          model: context.config.defaultModel,
          search_provider: context.config.search.provider,
          endpoints: ["POST /v1/responses", "GET /v1/models"],
        }),
      );
    }

    if (path === "/v1/models") {
      if (request.method !== "GET") return withCors(methodNotAllowed("GET"));
      return withCors(
        json({
          object: "list",
          data: [
            {
              id: context.config.defaultModel,
              object: "model",
              created: 0,
              owned_by: "fx-proxy",
            },
          ],
        }),
      );
    }

    if (path === "/v1/responses" || path === "/responses") {
      if (request.method !== "POST") return withCors(methodNotAllowed("POST"));
      return withCors(await handleResponses(request, context));
    }

    return withCors(
      errorResponse(404, `unknown route: ${request.method} ${path}`, "invalid_request_error"),
    );
  } catch (error) {
    return withCors(toErrorResponse(error, context));
  }
}

function toErrorResponse(error: unknown, context: RouterContext): Response {
  if (error instanceof RequestError) {
    return errorResponse(error.status, error.message, error.code, error.param);
  }
  if (error instanceof ConfigError) {
    return errorResponse(
      error.status,
      error.message,
      error.status === 401 ? "invalid_request_error" : "server_error",
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  context.log?.(`unhandled error: ${message}`);
  return errorResponse(500, message, "server_error");
}

function errorResponse(status: number, message: string, type: string, param?: string): Response {
  return json(
    {
      error: {
        message,
        type,
        param: param ?? null,
        code: null,
      },
    },
    status,
  );
}

function methodNotAllowed(allowed: string): Response {
  const response = errorResponse(405, `method not allowed; use ${allowed}`, "invalid_request_error");
  const headers = new Headers(response.headers);
  headers.set("allow", `${allowed}, OPTIONS`);
  return new Response(response.body, { status: 405, headers });
}

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) headers.set(key, value);
  return new Response(response.body, { status: response.status, headers });
}
