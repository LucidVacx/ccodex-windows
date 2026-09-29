import { readFileSync } from "node:fs";

const read = (name: string) => readFileSync(new URL(`../instructions/${name}`, import.meta.url), "utf8").trim();
const CLAUDE = read("ccodex_extra_claude_instructions.md");
const COMMON = read("ccodex_extra_common_instructions.md");

/** Appended to Claude Code's own system prompt: what the app shows beyond a terminal, and our formatting. */
export function claudeInstructions(formatting: boolean): string {
  return formatting ? `${CLAUDE}\n\n${COMMON}` : CLAUDE;
}

/** Desktop's developer instructions with our formatting joining its app context. */
export function withFormatting(developerInstructions: string): string {
  return developerInstructions.replace("</app-context>", `\n${COMMON}\n</app-context>`);
}
