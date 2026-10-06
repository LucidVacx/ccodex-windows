import { execFile, spawnSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import { relayBinary } from "../gateway/remote.js";
import type { CommandAction } from "../protocol/codex.js";

type ParsedCommand =
  | { type: "read"; cmd: string; name: string; path: string }
  | { type: "list_files"; cmd: string; path: string | null }
  | { type: "search"; cmd: string; query: string | null; path: string | null }
  | { type: "unknown"; cmd: string };

/** Each command's parse, a failed one too (history projects the same commands page after page). */
const cache = new Map<string, readonly ParsedCommand[] | undefined>();
const maxCacheEntries = 16_384;
let binary: string | null | undefined;

function parserBinary(): string | null {
  if (binary !== undefined) return binary;
  try {
    return binary = process.env.CCODEX_COMMAND_PARSER ?? relayBinary();
  } catch {
    return binary = null;
  }
}

const RUN = { encoding: "utf8", timeout: 10_000, maxBuffer: 64 << 20, windowsHide: true } as const;

/** The parser's answer for `commands`, or undefined when it failed. */
function decode(stdout: string | undefined, commands: readonly string[]): readonly (readonly ParsedCommand[])[] | undefined {
  if (stdout === undefined) return undefined;
  try {
    const value = JSON.parse(stdout) as ParsedCommand[][];
    return Array.isArray(value) && value.length === commands.length ? value : undefined;
  } catch {
    return undefined;
  }
}

function remember(commands: readonly string[], values: readonly (readonly ParsedCommand[])[] | undefined): void {
  commands.forEach((command, index) => {
    if (cache.size >= maxCacheEntries) cache.delete(cache.keys().next().value!);
    cache.set(command, values?.[index]);
  });
}

/** Parses the commands not parsed yet in one run of the parser (a page of history has hundreds), off the event loop. */
export async function parseCommands(commands: readonly string[]): Promise<void> {
  const parser = parserBinary();
  const fresh = [...new Set(commands)].filter((command) => command && !cache.has(command));
  if (!parser || !fresh.length) return;
  const stdout = await new Promise<string | undefined>((resolve) => {
    execFile(parser, ["parse-commands"], RUN, (error, output) => resolve(error ? undefined : output)).stdin?.end(JSON.stringify(fresh));
  });
  remember(fresh, decode(stdout, fresh));
}

/** One live command's parse, at once (history's are parsed a page at a time). */
function parsed(command: string): readonly ParsedCommand[] | undefined {
  const parser = parserBinary();
  if (parser && !cache.has(command)) {
    const result = spawnSync(parser, ["parse-commands"], { ...RUN, input: JSON.stringify([command]) });
    remember([command], decode(result.error || result.status !== 0 ? undefined : result.stdout, [command]));
  }
  return cache.get(command);
}

export function bashCommandActions(command: string, cwd: string): CommandAction[] {
  if (!command) return [];
  const actions = parsed(command);
  if (!actions) return [{ type: "unknown", command }];
  return actions.map((action): CommandAction => {
    if (action.type === "read") {
      const path = isAbsolute(action.path) ? action.path : resolve(cwd, action.path);
      return { type: "read", command: action.cmd, name: action.name, path };
    }
    if (action.type === "list_files") return { type: "listFiles", command: action.cmd, path: action.path };
    if (action.type === "search") return { type: "search", command: action.cmd, query: action.query, path: action.path };
    return { type: "unknown", command: action.cmd };
  });
}
