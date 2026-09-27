/** Stock's `thread/search` for Claude sessions: ripgrep finds the transcript lines holding the term, the first
 *  visible message (a user prompt or Claude's text, not tool calls or their output) holding it is the snippet. */
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { parseTranscriptLine } from "./records.js";
import { slashCommand, startsTurn, userText } from "./summary.js";

const CONTEXT = 60;

/** Stock's snippet: the match with up to 60 characters around it, whitespace collapsed. */
export function snippet(text: string, term: string): string | undefined {
  const flat = text.replace(/\s+/gu, " ").trim();
  const at = flat.toLowerCase().indexOf(term);
  if (at < 0) return undefined;
  const start = Math.max(0, at - CONTEXT);
  const end = Math.min(flat.length, at + term.length + CONTEXT);
  return `${start > 0 ? "..." : ""}${flat.slice(start, end)}${end < flat.length ? "..." : ""}`;
}

function visibleText(line: string): string | undefined {
  const record = parseTranscriptLine(Buffer.from(line));
  if (!record || ("isSidechain" in record && record.isSidechain)) return undefined;
  if (record.type === "user") return startsTurn(record) ? slashCommand(userText(record)) ?? userText(record) : undefined;
  if (record.type !== "assistant" || !Array.isArray(record.message.content)) return undefined;
  return record.message.content.flatMap((block) => block.type === "text" ? [String(block.text)] : []).join("\n");
}

/**
 * Transcript path → snippet for every top-level transcript under `projectsDir` whose visible messages hold `term`,
 * any case. Claude's own ripgrep (its binary run as `rg`) does the reading; lines over 100 KB (tool output) are
 * left out.
 */
export async function searchTranscripts(claudeBinary: string, projectsDir: string, term: string): Promise<Map<string, string>> {
  const lower = term.toLowerCase();
  const child = spawn(claudeBinary, ["--null", "--no-heading", "--no-line-number", "--fixed-strings", "--ignore-case",
    "--max-columns", "100000", "--no-ignore", "--hidden", "--max-depth", "2", "--glob", "*.jsonl", "--", term, projectsDir],
  { argv0: "rg", stdio: ["ignore", "pipe", "pipe"] });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  // 0: found, 1: nothing found.
  const exited = new Promise<void>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => code === 0 || code === 1 ? resolve() : reject(new Error(`rg: ${stderr.trim()}`)));
  });
  const found = new Map<string, string>();
  for await (const line of createInterface({ input: child.stdout, crlfDelay: Infinity })) {
    const split = line.indexOf("\0");
    const path = line.slice(0, split);
    if (found.has(path)) continue;
    const text = visibleText(line.slice(split + 1));
    const match = text && snippet(text, lower);
    if (match) found.set(path, match);
  }
  await exited;
  return found;
}
