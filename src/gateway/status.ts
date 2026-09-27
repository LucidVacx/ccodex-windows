import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { packageVersion } from "../management/commands.js";
import type { JsonObject, ThreadItem, Turn } from "../protocol/codex.js";
import { startedTurn } from "../protocol/turnPagination.js";
import type { Connection } from "./connection.js";
import type { Gateway } from "./server.js";

const COMMANDS = new Set(["cc", "ccstatus", "ccodex", "ccstate"]);
const SKILL = "ccodex:status";
/** What Desktop sends for the picked skill. */
const SKILL_CHIP = /^\[\$ccodex:status\]\([^)]*\)$/u;

/**
 * The command as a skill, so the App's `/` menu offers it: "CCodex status" comes first for `/cc`, `/ccodex`,
 * `/ccstatus`. Its SKILL.md is only what the App shows for it; the model never gets it.
 */
export async function statusSkill(dataDir: string): Promise<JsonObject> {
  const path = join(dataDir, "virtual", "ccodex-status", "SKILL.md");
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `---\nname: ${SKILL}\ndescription: CCodex status of this chat\n---\n\nCCodex answers this itself (same as \`/cc\`); the model never sees it.\n`);
  return {
    name: SKILL,
    description: "Model, context, Claude and Codex limits, session of this chat",
    interface: { displayName: "CCodex status", shortDescription: "Model, context, limits, session" },
    path,
    scope: "system",
    enabled: true,
    pluginId: null,
  };
}

/** `/cc` (or `/ccstatus`, `/ccodex`, `/ccstate`, with or without the slash, or the skill): CCodex's status of this chat. */
export function isStatusCommand(params: JsonObject): boolean {
  const input = params.input ?? [];
  if (input.length !== 1) return false;
  if (input[0].type === "skill") return input[0].name === SKILL;
  const text = input[0].type === "text" ? String(input[0].text).trim() : "";
  return COMMANDS.has(text.toLowerCase().replace(/^\//u, "")) || SKILL_CHIP.test(text);
}

interface Window {
  usedPercent: number;
  windowDurationMins: number | null;
  resetsAt: number | null;
}

const PERMISSIONS: Record<string, string> = {
  default: "Ask", acceptEdits: "Accept edits", plan: "Plan", auto: "Auto", dontAsk: "Don't ask", bypassPermissions: "Bypass",
};

const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
const clock = (date: Date) => date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

function bar(percent: number): string {
  const filled = Math.round(Math.min(100, Math.max(0, percent)) / 5);
  return `\`${"█".repeat(filled)}${"░".repeat(20 - filled)}\``;
}

function tokens(value: number): string {
  return value < 1000 ? String(value) : value < 1_000_000 ? `${(value / 1000).toFixed(1).replace(/\.0$/u, "")}k` : `${(value / 1_000_000).toFixed(2).replace(/\.?0+$/u, "")}M`;
}

function reset(seconds: number | null): string {
  if (!seconds) return "";
  const date = new Date(seconds * 1000);
  const day = date.toDateString() === new Date().toDateString() ? "" : `${date.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, `;
  return ` · resets ${day}${clock(date)}`;
}

function limitRows(provider: string, limits: JsonObject): string[] {
  return [limits.primary, limits.secondary].filter((window): window is Window => Boolean(window)).map((window) => {
    const label = window.windowDurationMins === 300 ? "5h" : window.windowDurationMins === 10_080 ? "week" : `${Math.round((window.windowDurationMins ?? 0) / 60)}h`;
    return `| **${provider} ${label}** | ${bar(window.usedPercent)} ${window.usedPercent}%${reset(window.resetsAt)} |`;
  });
}

async function statusText(gateway: Gateway, connection: Connection, threadId: string): Promise<string> {
  const segments = gateway.meta.lineage(threadId);
  const current = segments?.at(-1)?.threadId ?? threadId;
  const claudeLimits: JsonObject = (await gateway.claude.rateLimits()).rateLimits;
  const claudeError = await gateway.claude.models().then(() => undefined, (error: unknown) => String(error));
  const codexLimits: JsonObject = await connection.upstream.request("account/rateLimits/read", {}).then(
    (value: JsonObject) => value.rateLimits as JsonObject, (error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  const rows: string[] = [];
  const session: string[] = [];
  let header: string;
  let cwd: string;
  let actions: { at: number; text: string }[] = [];
  if (gateway.isClaudeThread(threadId)) {
    const state = gateway.claude.state(current);
    const usage = state.lastUsage as JsonObject | undefined;
    const status = state.running ? "🟢 Running" : state.process ? "🟢 Ready" : "🟡 Idle";
    header = [`**❋ Claude ${state.model}**`, state.effort && capital(state.effort), state.fast && "Fast", PERMISSIONS[state.permissionMode] ?? state.permissionMode, status]
      .filter(Boolean).join(" · ");
    if (usage?.totalTokens && state.contextWindow) {
      const percent = Math.round(100 * usage.inputTokens / Number(state.contextWindow));
      rows.push(`| **Context** | ${bar(percent)} ${percent}% · ${tokens(usage.inputTokens)} / ${tokens(Number(state.contextWindow))} |`);
    }
    session.push(state.running ? "working on a turn" : state.process ? "Claude process running" : state.loaded
      ? "process unloaded, the next message restarts it" : "not opened since the gateway started");
    if (state.backgroundTasks) session.push(`${state.backgroundTasks} background task${state.backgroundTasks === 1 ? "" : "s"}`);
    if (state.costUsd) session.push(`$${Number(state.costUsd).toFixed(2)} spent`);
    cwd = state.cwd;
    actions = state.actions;
  } else {
    const { thread } = await connection.upstream.request("thread/read", { threadId: current });
    header = [`**֎ ${thread.model ?? "Codex"}**`, thread.reasoningEffort && capital(thread.reasoningEffort),
      thread.status?.type === "active" ? "🟢 Running" : "🟢 Ready"].filter(Boolean).join(" · ");
    cwd = thread.cwd;
  }
  if (segments) session.push(segments.map((segment) => segment.provider === "claude" ? "Claude" : "GPT").join(" → "));
  rows.push(...claudeError ? [`| **Claude** | 🔴 ${claudeError} |`]
    : claudeLimits.primary || claudeLimits.secondary
      ? [...limitRows("Claude", claudeLimits), ...gateway.claude.modelLimits.flatMap(({ name, window }) => limitRows(`Claude ${name}`, { primary: window }))] : [`| **Claude** | 🔴 ${gateway.claude.usageError ?? "limits unavailable"} |`]);
  rows.push(...codexLimits.error ? [`| **Codex** | 🔴 ${codexLimits.error} |`] : limitRows("Codex", codexLimits));
  const home = homedir();
  return [
    `### ◆ CCodex \`${packageVersion()}\``,
    "",
    header,
    "",
    "| | |",
    "|:--|:--|",
    ...rows,
    "",
    ...session.length ? [`**Session** — ${session.join(" · ")}`, ""] : [],
    ...actions.length ? ["**Recent actions**", ...actions.map((action) => `- \`${clock(new Date(action.at))}\` ${capital(action.text)}`), ""] : [],
    `_Thread \`${threadId}\` · \`${cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd}\`_`,
  ].join("\n");
}

async function answer(gateway: Gateway, connection: Connection, threadId: string, turnId: string, id: string, params: JsonObject): Promise<void> {
  const user: ThreadItem = { type: "userMessage", id: `${id}:user`, clientId: params.clientUserMessageId ?? null, content: params.input };
  connection.notify("item/started", { item: user, threadId, turnId, startedAtMs: Date.now() });
  connection.notify("item/completed", { item: user, threadId, turnId, completedAtMs: Date.now() });
  const text = await statusText(gateway, connection, threadId)
    .catch((error: unknown) => `### ◆ CCodex\n\n🔴 Status failed: ${error instanceof Error ? error.message : String(error)}`);
  const item: ThreadItem = { type: "agentMessage", id: `${id}:answer`, text, phase: "final_answer", memoryCitation: null };
  connection.notify("item/started", { item: { ...item, text: "" }, threadId, turnId, startedAtMs: Date.now() });
  connection.notify("item/agentMessage/delta", { threadId, turnId, itemId: item.id, delta: text });
  connection.notify("item/completed", { item, threadId, turnId, completedAtMs: Date.now() });
}

/**
 * The status command: an answer that exists only on the wire, never in any transcript or before the model. Sent
 * while a turn runs (a steer), it shows inside that turn and leaves the turn alone; otherwise it is a turn of its own.
 */
export async function statusCommand(gateway: Gateway, connection: Connection, method: string, params: JsonObject): Promise<unknown> {
  const threadId: string = params.threadId;
  const id = `ccodex-${randomUUID()}`;
  if (method === "turn/steer") {
    setImmediate(() => void answer(gateway, connection, threadId, params.expectedTurnId, id, params));
    return { turnId: params.expectedTurnId };
  }
  const now = Math.floor(Date.now() / 1000);
  const turn: Turn = { id, items: [], itemsView: "notLoaded", status: "inProgress", error: null, startedAt: now, completedAt: null, durationMs: null };
  setImmediate(() => void (async () => {
    connection.notify("turn/started", { threadId, turn });
    connection.notify("thread/status/changed", { threadId, status: { type: "active", activeFlags: [] } });
    await answer(gateway, connection, threadId, id, id, params);
    connection.notify("turn/completed", { threadId, turn: { ...turn, status: "completed", completedAt: Math.floor(Date.now() / 1000), durationMs: Date.now() - now * 1000 } });
    // Desktop keeps the thread spinning in the sidebar until the thread is idle again.
    connection.notify("thread/status/changed", { threadId, status: { type: "idle" } });
  })());
  return { turn: startedTurn(turn) };
}
