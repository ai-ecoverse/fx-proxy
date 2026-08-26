import { ToolError } from "./search.js";
import { htmlToText, truncate } from "../util/text.js";

export interface FetchedPage {
  url: string;
  status: number;
  contentType: string;
  title?: string;
  text: string;
  truncated: boolean;
}

const userAgent =
  "Mozilla/5.0 (compatible; fx-proxy/0.1; +https://github.com/ai-ecoverse/fx-proxy)";

const blockedHosts = [
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "[::1]",
  "metadata.google.internal",
  "169.254.169.254",
];

export function assertFetchableUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ToolError(`not a valid absolute URL: ${raw}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new ToolError(`unsupported URL scheme: ${url.protocol}`);
  }
  const host = url.hostname.toLowerCase();
  if (
    blockedHosts.includes(host) ||
    host.endsWith(".internal") ||
    host.endsWith(".local") ||
    /^10\./.test(host) ||
    /^192\.168\./.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw new ToolError(`refusing to fetch a private or loopback host: ${host}`);
  }
  return url;
}

export async function fetchPage(raw: string, maxChars: number): Promise<FetchedPage> {
  const url = assertFetchableUrl(raw);
  const response = await fetch(url, {
    headers: {
      "user-agent": userAgent,
      accept: "text/html,application/xhtml+xml,text/plain,application/json;q=0.9,*/*;q=0.5",
    },
    redirect: "follow",
  });
  const contentType = response.headers.get("content-type") ?? "";
  const body = await response.text();

  if (isBinary(contentType)) {
    throw new ToolError(`unsupported content type for text extraction: ${contentType}`);
  }

  const isHtml = /html|xml/i.test(contentType) || /^\s*<(!doctype|html)/i.test(body);
  const extracted = isHtml ? htmlToText(body) : body;
  const { text, truncated } = truncate(extracted, maxChars);

  return {
    url: response.url || url.toString(),
    status: response.status,
    contentType,
    title: isHtml ? extractTitle(body) : undefined,
    text,
    truncated,
  };
}

function isBinary(contentType: string): boolean {
  return /^(image|audio|video|font)\//i.test(contentType) ||
    /application\/(octet-stream|pdf|zip|gzip|wasm)/i.test(contentType);
}

function extractTitle(html: string): string | undefined {
  const raw = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return raw ? htmlToText(raw).slice(0, 300) : undefined;
}
