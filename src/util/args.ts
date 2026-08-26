export interface ParsedCommand {
  name: string;
  args: string[];
  flags: Record<string, string | true>;
}

export class CommandSyntaxError extends Error {}

/**
 * Minimal POSIX-ish tokenizer: single and double quotes, backslash escapes.
 * Shell operators are intentionally unsupported; the sandbox has no shell.
 */
export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let hasToken = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index] as string;
    if (quote === null && (char === " " || char === "\t" || char === "\n")) {
      if (hasToken) tokens.push(current);
      current = "";
      hasToken = false;
      continue;
    }
    if (quote === null && (char === '"' || char === "'")) {
      quote = char;
      hasToken = true;
      continue;
    }
    if (quote !== null && char === quote) {
      quote = null;
      continue;
    }
    if (char === "\\" && quote !== "'" && index + 1 < input.length) {
      index += 1;
      current += input[index];
      hasToken = true;
      continue;
    }
    current += char;
    hasToken = true;
  }
  if (quote !== null) throw new CommandSyntaxError("unterminated quote");
  if (hasToken) tokens.push(current);
  return tokens;
}

const operators = ["|", "||", "&&", ";", ">", ">>", "<", "&"];

export function parseCommand(input: string): ParsedCommand {
  const tokens = tokenize(input);
  if (tokens.length === 0) throw new CommandSyntaxError("empty command");
  const [name, ...rest] = tokens as [string, ...string[]];

  const args: string[] = [];
  const flags: Record<string, string | true> = {};
  for (const token of rest) {
    if (operators.includes(token)) {
      throw new CommandSyntaxError(
        `shell operator '${token}' is not supported; run one command at a time`,
      );
    }
    if (token.startsWith("--") && token.length > 2) {
      const separator = token.indexOf("=");
      if (separator === -1) flags[token.slice(2)] = true;
      else flags[token.slice(2, separator)] = token.slice(separator + 1);
      continue;
    }
    args.push(token);
  }
  return { name, args, flags };
}

export function flagNumber(
  flags: Record<string, string | true>,
  name: string,
  fallback: number,
  max: number,
): number {
  const raw = flags[name];
  if (typeof raw !== "string") return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

export function flagString(
  flags: Record<string, string | true>,
  name: string,
): string | undefined {
  const raw = flags[name];
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
