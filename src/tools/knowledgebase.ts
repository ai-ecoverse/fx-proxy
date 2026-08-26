import { ToolError } from "./search.js";
import { assertFetchableUrl } from "./fetchPage.js";
import { truncate } from "../util/text.js";

export interface Knowledgebase {
  org: string;
  repo: string;
  ref: string;
}

export interface KnowledgebasePage {
  path: string;
  lastmod?: string;
  title?: string;
  description?: string;
}

export interface ListPagesQuery {
  prefix?: string;
  query?: string;
  limit: number;
}

export interface ListedPages {
  origin: string;
  site: string;
  total: number;
  pages: KnowledgebasePage[];
}

export interface KnowledgebaseDocument {
  path: string;
  url: string;
  status: number;
  title?: string;
  text: string;
  truncated: boolean;
}

const userAgent =
  "Mozilla/5.0 (compatible; fx-proxy/0.1; +https://github.com/ai-ecoverse/fx-proxy)";

const defaultRef = "main";
const maxSitemapBytes = 5_000_000;
const maxNestedSitemaps = 8;
const namePattern = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]{0,62}[a-zA-Z0-9])?$/;

/**
 * Bound site, if the caller sent both org and repo. Missing or malformed
 * values yield `undefined` so the tools stay undeclared rather than failing
 * a request that never asked for them.
 */
export function parseKnowledgebaseHeaders(headers: Headers): Knowledgebase | undefined {
  const org = header(headers, ["x-org", "x-owner", "x-aem-org"]);
  const repo = header(headers, ["x-repo", "x-site", "x-aem-repo"]);
  if (!org || !repo) return undefined;
  const ref = header(headers, ["x-ref", "x-aem-ref"]) ?? defaultRef;
  return parseKnowledgebase({ org, repo, ref });
}

export function parseKnowledgebase(parts: { org: string; repo: string; ref?: string }): Knowledgebase {
  return {
    org: assertName("org", parts.org),
    repo: assertName("repo", parts.repo),
    ref: assertName("ref", parts.ref ?? defaultRef),
  };
}

export function knowledgebaseOrigin(site: Knowledgebase): string {
  return `https://${site.ref}--${site.repo}--${site.org}.aem.live`;
}

export function knowledgebaseLabel(site: Knowledgebase): string {
  return `${site.org}/${site.repo}@${site.ref}`;
}

export async function listPages(site: Knowledgebase, query: ListPagesQuery): Promise<ListedPages> {
  const origin = knowledgebaseOrigin(site);
  const [sitemapPages, index] = await Promise.all([
    loadSitemapPages(origin),
    loadQueryIndex(origin).catch(() => new Map<string, KnowledgebasePage>()),
  ]);

  const merged = sitemapPages.map((page) => {
    const extra = index.get(normalizeListedPath(page.path));
    return extra ? { ...page, title: extra.title || page.title, description: extra.description } : page;
  });

  const prefix = query.prefix ? normalizeListedPath(query.prefix) : undefined;
  const needle = query.query?.trim().toLowerCase();
  const filtered = merged.filter((page) => {
    // `/docs` matches `/docs` and `/docs/faq`, but not `/documentation`.
    if (prefix && prefix !== "/" && page.path !== prefix && !page.path.startsWith(`${prefix}/`)) {
      return false;
    }
    if (needle) {
      const haystack = `${page.path} ${page.title ?? ""} ${page.description ?? ""}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }
    return true;
  });

  return {
    origin,
    site: knowledgebaseLabel(site),
    total: filtered.length,
    pages: filtered.slice(0, query.limit),
  };
}

export async function getPage(
  site: Knowledgebase,
  rawPath: string,
  maxChars: number,
): Promise<KnowledgebaseDocument> {
  const origin = knowledgebaseOrigin(site);
  const path = canonicalPath(rawPath);
  const candidates = markdownCandidates(path);
  let lastStatus = 0;
  let lastType = "";

  for (const candidate of candidates) {
    const url = `${origin}${candidate}`;
    const response = await fetch(url, {
      headers: {
        "user-agent": userAgent,
        accept: "text/markdown, text/plain;q=0.9, */*;q=0.1",
      },
      redirect: "follow",
    });
    lastStatus = response.status;
    lastType = response.headers.get("content-type") ?? "";
    if (response.status === 404) continue;
    if (!response.ok) {
      throw new ToolError(`failed to fetch ${candidate}: HTTP ${response.status}`);
    }
    if (isMarkdown(lastType, candidate)) {
      const body = await response.text();
      const { text, truncated } = truncate(body, maxChars);
      return {
        path,
        url: response.url || url,
        status: response.status,
        title: markdownTitle(body),
        text,
        truncated,
      };
    }
  }

  throw new ToolError(
    lastStatus === 404
      ? `path not found: ${path}`
      : `no markdown representation for ${path} (HTTP ${lastStatus || 404}${lastType ? `, ${lastType}` : ""})`,
  );
}

/** Exported for tests: turns a sitemap document into page paths. */
export function parseSitemap(xml: string, origin: string): { pages: KnowledgebasePage[]; sitemaps: string[] } {
  const sitemaps: string[] = [];
  const pages: KnowledgebasePage[] = [];
  const isIndex = /<sitemapindex[\s>]/i.test(xml);

  if (isIndex) {
    for (const match of xml.matchAll(tagPattern("loc"))) {
      const loc = decodeXml(match[1] ?? "").trim();
      if (loc) sitemaps.push(loc);
    }
    return { pages, sitemaps };
  }

  const blocks = xml.split(/<url[\s>]/i).slice(1);
  for (const block of blocks) {
    const loc = decodeXml(firstTag(block, "loc") ?? "").trim();
    if (!loc) continue;
    const path = pathFromLoc(loc, origin);
    if (!path) continue;
    const lastmod = decodeXml(firstTag(block, "lastmod") ?? "").trim() || undefined;
    pages.push({ path, lastmod });
  }
  return { pages, sitemaps };
}

export function canonicalPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) throw new ToolError("path must not be empty");

  let pathname: string;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch {
      throw new ToolError(`not a valid URL: ${trimmed}`);
    }
    pathname = url.pathname;
  } else {
    pathname = trimmed;
  }

  let path = pathname.split(/[?#]/)[0] ?? pathname;
  path = path.replace(/\\/g, "/");
  if (!path.startsWith("/")) path = `/${path}`;
  path = path.replace(/\/{2,}/g, "/");
  if (path.includes("\0") || path.split("/").includes("..") || path.includes("%2e%2e")) {
    throw new ToolError(`refusing a path that escapes the site: ${raw}`);
  }
  if (path.endsWith(".md")) path = path.slice(0, -3);
  if (path.endsWith(".html")) path = path.slice(0, -5);
  if (path.length > 1) path = path.replace(/\/+$/, "");
  if (!path) path = "/";
  return path;
}

export function markdownCandidates(path: string): string[] {
  if (path === "/") return ["/index.md"];
  return [`${path}.md`, `${path}/index.md`];
}

function header(headers: Headers, names: string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name)?.trim();
    if (value) return value;
  }
  return undefined;
}

function assertName(label: string, value: string): string {
  const trimmed = value.trim();
  if (!namePattern.test(trimmed) || trimmed.includes("--")) {
    throw new ToolError(
      `invalid ${label} '${value}': use a GitHub-style name (letters, digits, dot, underscore, hyphen)`,
    );
  }
  return trimmed;
}

async function loadSitemapPages(origin: string): Promise<KnowledgebasePage[]> {
  const seen = new Set<string>();
  const pages: KnowledgebasePage[] = [];
  const queue = [`${origin}/sitemap.xml`];

  while (queue.length > 0 && seen.size < maxNestedSitemaps) {
    const loc = queue.shift()!;
    if (seen.has(loc)) continue;
    seen.add(loc);
    const xml = await readText(loc, "sitemap");
    const parsed = parseSitemap(xml, origin);
    for (const page of parsed.pages) pages.push(page);
    for (const nested of parsed.sitemaps) {
      if (queue.length + seen.size >= maxNestedSitemaps) break;
      try {
        const url = assertFetchableUrl(nested);
        if (url.pathname.toLowerCase().endsWith(".xml")) queue.push(url.toString());
      } catch {
        // Ignore nested sitemap URLs we refuse to fetch.
      }
    }
  }

  return dedupePages(pages);
}

async function loadQueryIndex(origin: string): Promise<Map<string, KnowledgebasePage>> {
  const payload = (await readJson(`${origin}/query-index.json`, "query-index")) as {
    data?: { path?: string; title?: string; description?: string }[];
  };
  const index = new Map<string, KnowledgebasePage>();
  for (const row of payload.data ?? []) {
    if (typeof row.path !== "string" || !row.path) continue;
    const path = normalizeListedPath(row.path);
    index.set(path, {
      path,
      title: typeof row.title === "string" ? row.title : undefined,
      description: typeof row.description === "string" ? row.description : undefined,
    });
  }
  return index;
}

async function readText(url: string, label: string): Promise<string> {
  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "application/xml, text/xml, text/plain;q=0.8" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new ToolError(`${label} fetch failed with HTTP ${response.status}`);
  }
  const buffer = await response.arrayBuffer();
  if (buffer.byteLength > maxSitemapBytes) {
    throw new ToolError(`${label} is larger than ${maxSitemapBytes} bytes`);
  }
  return new TextDecoder().decode(buffer);
}

async function readJson(url: string, label: string): Promise<unknown> {
  const response = await fetch(url, {
    headers: { "user-agent": userAgent, accept: "application/json" },
    redirect: "follow",
  });
  if (!response.ok) {
    throw new ToolError(`${label} fetch failed with HTTP ${response.status}`);
  }
  return response.json();
}

function pathFromLoc(loc: string, origin: string): string | undefined {
  try {
    const url = new URL(loc, origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return canonicalPath(url.pathname);
  } catch {
    return undefined;
  }
}

function normalizeListedPath(path: string): string {
  try {
    return canonicalPath(path);
  } catch {
    const trimmed = path.trim();
    return trimmed.startsWith("/") ? trimmed.replace(/\/+$/, "") || "/" : `/${trimmed}`;
  }
}

function dedupePages(pages: KnowledgebasePage[]): KnowledgebasePage[] {
  const seen = new Set<string>();
  const unique: KnowledgebasePage[] = [];
  for (const page of pages) {
    if (seen.has(page.path)) continue;
    seen.add(page.path);
    unique.push(page);
  }
  return unique;
}

function tagPattern(name: string): RegExp {
  return new RegExp(`<(?:[\\w.-]+:)?${name}\\b[^>]*>([\\s\\S]*?)</(?:[\\w.-]+:)?${name}>`, "gi");
}

function firstTag(input: string, name: string): string | undefined {
  return [...input.matchAll(tagPattern(name))][0]?.[1];
}

function decodeXml(value: string): string {
  return value
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function isMarkdown(contentType: string, path: string): boolean {
  if (/markdown|text\/plain/i.test(contentType)) return true;
  if (/html/i.test(contentType)) return false;
  return path.endsWith(".md");
}

function markdownTitle(body: string): string | undefined {
  const heading = body.match(/^#\s+(.+)$/m)?.[1]?.trim();
  return heading || undefined;
}
