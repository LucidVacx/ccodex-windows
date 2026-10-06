/** Stock's `thread/search` for Claude sessions: ripgrep finds the transcript lines holding the term, the first
 *  visible message (a user prompt or Claude's text, not tool calls or their output) holding it is the snippet. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseTranscriptLine } from "./records.js";
import { slashCommand, startsTurn, userText } from "./summary.js";

/** Stock's snippet (codex-rs/rollout/src/search.rs `excerpt_around_match`): whitespace collapsed, the match with the
 *  49 characters before it and 96 after, "... " / " ..." where the text goes on. */
export function snippet(text: string, term: string): string | undefined {
  const flat = text.split(/\s+/u).filter(Boolean).join(" ");
  const at = flat.toLowerCase().indexOf(term);
  if (at < 0) return undefined;
  const before = [...flat.slice(0, at)];
  const after = [...flat.slice(at + term.length)];
  const start = Math.max(0, before.length - 49);
  const cut = after.length > 96;
  const excerpt = `${before.slice(start).join("")}${flat.slice(at, at + term.length)}${after.slice(0, 96).join("")}`.trim();
  return `${start > 0 ? "... " : ""}${excerpt}${cut ? " ..." : ""}`;
}

function visibleText(line: string): string | undefined {
  const record = parseTranscriptLine(Buffer.from(line));
  if (!record || ("isSidechain" in record && record.isSidechain)) return undefined;
  if (record.type === "user") return startsTurn(record) ? slashCommand(userText(record)) ?? userText(record) : undefined;
  if (record.type !== "assistant" || !Array.isArray(record.message.content)) return undefined;
  return record.message.content.flatMap((block) => block.type === "text" ? [String(block.text)] : []).join("\n");
}

/** Claude's own ripgrep (its binary run as `rg`) over `args`, a fixed string any case; each output line to `line`, which stops the search by returning true. Lines over 100 KB (tool output) are left out. */
async function ripgrep(claudeBinary: string, args: string[], line: (text: string) => boolean): Promise<void> {
  const child = spawn(claudeBinary, ["--fixed-strings", "--ignore-case", "--max-columns", "100000", "--no-ignore", "--hidden", ...args],
    { argv0: "rg", stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // 0: found, 1: nothing found; stopped early: killed.
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 || code === 1 || child.killed ? resolve() : reject(new Error(`rg: ${stderr.trim()}`)));
  });
  for await (const text of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    if (line(text)) {
      child.kill();
      break;
    }
  }
  await exited;
}

/** Transcript path → snippet for every top-level transcript under `projectsDir` whose visible messages hold `term`. */
export async function searchTranscripts(claudeBinary: string, projectsDir: string, term: string): Promise<Map<string, string>> {
  const lower = term.toLowerCase();
  const found = new Map<string, string>();
  await ripgrep(claudeBinary, ["--null", "--no-heading", "--no-line-number", "--max-depth", "2", "--glob", "*.jsonl", "--", term, projectsDir], (line) => {
    const split = line.indexOf("\0");
    const path = line.slice(0, split);
    if (found.has(path)) return false;
    const text = visibleText(line.slice(split + 1));
    const match = text && snippet(text, lower);
    if (match) found.set(path, match);
    return false;
  });
  return found;
}

/** Where (bytes into the file) the first visible message of the transcript holding `term` is, if one does. */
export async function firstMatch(claudeBinary: string, path: string, term: string): Promise<number | undefined> {
  const lower = term.toLowerCase();
  let offset: number | undefined;
  await ripgrep(claudeBinary, ["--byte-offset", "--no-filename", "--no-line-number", "--", term, path], (line) => {
    const split = line.indexOf(":");
    if (!visibleText(line.slice(split + 1))?.toLowerCase().includes(lower)) return false;
    offset = Number(line.slice(0, split));
    return true;
  });
  return offset;
}
