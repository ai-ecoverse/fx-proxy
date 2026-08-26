const namedEntities: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  hellip: "…",
  mdash: "—",
  ndash: "–",
  rsquo: "’",
  lsquo: "‘",
  ldquo: "“",
  rdquo: "”",
  middot: "·",
  bull: "•",
  eacute: "é",
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#x?[0-9a-f]+|[a-z][a-z0-9]*);?/gi, (match, entity: string) => {
    if (entity.startsWith("#")) {
      const codePoint = entity[1]?.toLowerCase() === "x"
        ? Number.parseInt(entity.slice(2), 16)
        : Number.parseInt(entity.slice(1), 10);
      if (Number.isFinite(codePoint) && codePoint > 0 && codePoint <= 0x10ffff) {
        try {
          return String.fromCodePoint(codePoint);
        } catch {
          return match;
        }
      }
      return match;
    }
    return namedEntities[entity.toLowerCase()] ?? match;
  });
}

export function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

/** Best-effort readable text extraction. Portable across runtimes: no HTMLRewriter. */
export function htmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, "\n")
    .replace(/<br\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "- ");
  return collapseBlankLines(decodeEntities(stripTags(withoutNoise)));
}

export function collapseBlankLines(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function truncate(text: string, maxChars: number): { text: string; truncated: boolean } {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: `${text.slice(0, maxChars)}\n[truncated at ${maxChars} characters]`, truncated: true };
}

/** Extracts the contents of the first matching HTML element, tags included. */
export function firstMatch(input: string, pattern: RegExp): string | undefined {
  return input.match(pattern)?.[1];
}
