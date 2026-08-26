import type {
  FxWorkspaceAdapter,
  FxWorkspaceExecRequest,
  FxWorkspaceExecResult,
} from "libfx/wasm";
import type { Config } from "../config.js";
import { CommandSyntaxError, flagNumber, flagString, parseCommand } from "../util/args.js";
import { fetchPage } from "../tools/fetchPage.js";
import { ToolError, search } from "../tools/search.js";
import type { SearchResult } from "../tools/search.js";

export const workspaceRoot = "/workspace";
export const workspaceHome = "/home/fx";

/** Upper bound per tool result; the host contract caps exec output at 64 KiB. */
const maxOutputChars = 24_000;

export interface ToolInvocation {
  id: string;
  tool: "web_search" | "web_fetch" | "shell";
  command: string;
  query?: string;
  url?: string;
}

export interface ToolCompletion extends ToolInvocation {
  exitCode: number;
  resultCount?: number;
  summary: string;
}

export interface ShellHooks {
  onStart?(invocation: ToolInvocation): void;
  onFinish?(completion: ToolCompletion): void;
}

export interface ShellOptions {
  config: Config;
  hooks?: ShellHooks;
}

/**
 * The workspace adapter fx sees as its terminal. There is no shell and no
 * filesystem behind it: every command is a host-implemented proxy tool, which is
 * what turns "one model call with no tools" into "one model with web search".
 */
export function createSandboxWorkspace(options: ShellOptions): FxWorkspaceAdapter {
  let counter = 0;

  return {
    info: {
      version: 1,
      root: workspaceRoot,
      cwd: workspaceRoot,
      home: workspaceHome,
      gitAvailable: false,
      ephemeral: true,
    },
    permission: "allow-sandboxed",
    async exec(request: FxWorkspaceExecRequest): Promise<FxWorkspaceExecResult> {
      counter += 1;
      const id = `call_${counter.toString().padStart(3, "0")}`;
      const invocation = describe(id, request.command);
      options.hooks?.onStart?.(invocation);

      const result = await run(request, options.config);
      options.hooks?.onFinish?.({
        ...invocation,
        exitCode: result.exitCode,
        resultCount: result.resultCount,
        summary: result.summary,
      });
      return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
    },
  };
}

function describe(id: string, command: string): ToolInvocation {
  let parsed;
  try {
    parsed = parseCommand(command);
  } catch {
    return { id, tool: "shell", command };
  }
  if (parsed.name === "web_search") {
    return { id, tool: "web_search", command, query: parsed.args.join(" ") };
  }
  if (parsed.name === "web_fetch") {
    return { id, tool: "web_fetch", command, url: parsed.args[0] };
  }
  return { id, tool: "shell", command };
}

interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  summary: string;
  resultCount?: number;
}

function ok(stdout: string, summary: string, resultCount?: number): RunResult {
  return { exitCode: 0, stdout, stderr: "", summary, resultCount };
}

function fail(stderr: string, exitCode = 1): RunResult {
  return { exitCode, stdout: "", stderr, summary: stderr.split("\n")[0] ?? stderr };
}

async function run(request: FxWorkspaceExecRequest, config: Config): Promise<RunResult> {
  let parsed;
  try {
    parsed = parseCommand(request.command);
  } catch (error) {
    const message = error instanceof CommandSyntaxError ? error.message : "cannot parse command";
    return fail(`${message}\n${usage()}`, 2);
  }

  try {
    switch (parsed.name) {
      case "web_search": {
        const query = parsed.args.join(" ").trim();
        if (!query) return fail(`web_search: missing query\n${usage()}`, 2);
        const results = await search(
          {
            query,
            count: flagNumber(parsed.flags, "count", 6, 20),
            site: flagString(parsed.flags, "site"),
            freshness: flagString(parsed.flags, "freshness"),
          },
          config,
        );
        if (results.length === 0) {
          return ok(`no results for: ${query}\n`, "no results", 0);
        }
        const rendered = parsed.flags.json
          ? JSON.stringify(results, null, 2)
          : renderResults(results);
        return ok(
          clamp(`${results.length} results for: ${query}\n\n${rendered}\n`),
          `${results.length} results`,
          results.length,
        );
      }

      case "web_fetch": {
        const target = parsed.args[0];
        if (!target) return fail(`web_fetch: missing URL\n${usage()}`, 2);
        const maxChars = flagNumber(parsed.flags, "max-chars", 12_000, maxOutputChars - 500);
        const page = await fetchPage(target, maxChars);
        const header = [
          `url: ${page.url}`,
          `status: ${page.status}`,
          page.title ? `title: ${page.title}` : undefined,
          "",
        ]
          .filter((line) => line !== undefined)
          .join("\n");
        return ok(
          clamp(`${header}${page.text}\n`),
          `${page.status} ${page.contentType.split(";")[0] ?? ""}`.trim(),
        );
      }

      case "help":
      case "commands":
        return ok(usage(), "usage");

      case "echo":
        return ok(`${parsed.args.join(" ")}\n`, "echo");

      case "pwd":
        return ok(`${request.cwd}\n`, request.cwd);

      case "date":
        return ok(`${new Date().toISOString()}\n`, "date");

      case "ls":
      case "cat":
      case "find":
      case "grep":
      case "git":
      case "curl":
      case "wget":
      case "python":
      case "python3":
      case "node":
        return fail(
          `${parsed.name}: unavailable. This sandbox has no filesystem, no package manager and no outbound shell access.\n${usage()}`,
          127,
        );

      default:
        return fail(`${parsed.name}: command not found\n${usage()}`, 127);
    }
  } catch (error) {
    if (error instanceof ToolError) return fail(`${parsed.name}: ${error.message}\n`);
    if (error instanceof Error && error.name === "AbortError") {
      return fail(`${parsed.name}: aborted\n`, 130);
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return fail(`${parsed.name}: timed out after ${request.timeoutMs}ms\n`, 124);
    }
    return fail(`${parsed.name}: ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

function renderResults(results: SearchResult[]): string {
  return results
    .map((result, index) => {
      const lines = [`${index + 1}. ${result.title || result.url}`, `   ${result.url}`];
      if (result.snippet) lines.push(`   ${result.snippet}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

function clamp(value: string): string {
  return value.length <= maxOutputChars
    ? value
    : `${value.slice(0, maxOutputChars)}\n[output truncated]`;
}

export function usage(): string {
  return [
    "available commands (host-provided, not a real shell):",
    '  web_search "<query>" [--count=N] [--site=domain] [--freshness=pd|pw|pm|py] [--json]',
    "  web_fetch <url> [--max-chars=N]",
    "  help | echo <text> | pwd | date",
    "",
    "one command per call; pipes, redirection and command chaining are unsupported.",
  ].join("\n");
}
