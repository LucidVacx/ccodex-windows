/**
 * Claude's registry of running sessions (`~/.claude/sessions/<pid>.json`): an entry goes when its process exits, but
 * one a force-stopped Claude leaves behind stays, and its pid may name another process since.
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../config.js";
import { isWindows, listWindowsProcesses, type WindowsProcessInfo } from "../platform/process.js";

/** An entry of Claude's registry of running sessions (`~/.claude/sessions/<pid>.json`). */
export interface SessionEntry {
  readonly pid: number;
  readonly sessionId: string;
  /** The process's creation time as Claude recorded it (Windows: a FILETIME, 100 ns since 1601). */
  readonly procStart?: string;
  /** When the entry was last written, ms since 1970. */
  readonly writtenMs: number;
}

export function sessionEntries(home = claudeHome()): SessionEntry[] {
  const directory = join(home, "sessions");
  let names: string[];
  try { names = readdirSync(directory); } catch { return []; }
  return names.flatMap((name) => {
    if (!name.endsWith(".json")) return [];
    try {
      const path = join(directory, name);
      const entry = JSON.parse(readFileSync(path, "utf8")) as { pid?: unknown; sessionId?: unknown; procStart?: unknown };
      if (!Number.isInteger(entry.pid) || typeof entry.sessionId !== "string") return [];
      const procStart = typeof entry.procStart === "string" || typeof entry.procStart === "number" ? String(entry.procStart) : undefined;
      return [{ pid: entry.pid as number, sessionId: entry.sessionId, ...(procStart ? { procStart } : {}), writtenMs: statSync(path).mtimeMs }];
    } catch {
      return []; // Being rewritten.
    }
  });
}

const FILETIME_EPOCH_MS = 11_644_473_600_000;

/**
 * Windows: whether a registry entry names the process it was written for. A force-stopped Claude leaves its entry
 * behind, and Windows reuses pids: the process must be the one Claude recorded (its creation time), or, for an entry
 * without one, a Claude process already running when the entry was written.
 */
export function entryNames(entry: SessionEntry, info: WindowsProcessInfo | undefined): boolean {
  if (!info || info.pid !== entry.pid) return false;
  if (entry.procStart && /^\d+$/u.test(entry.procStart)) {
    return Math.abs(Number(BigInt(entry.procStart) / 10_000n) - info.createdMs) <= 1;
  }
  return /^claude(?:\.exe)?$/iu.test(info.name) && info.createdMs > 0 && info.createdMs <= entry.writtenMs + FILETIME_EPOCH_MS;
}

/**
 * The parent of the process a registry entry names; undefined once it is gone (Windows: or when the entry is stale,
 * its pid reused). 0: orphaned, as POSIX reparents to init.
 */
export async function entryParent(entry: SessionEntry): Promise<number | undefined> {
  if (isWindows) {
    try {
      const found = await listWindowsProcesses({ pids: [entry.pid], withParents: true });
      const info = found.find((candidate) => candidate.pid === entry.pid);
      if (!entryNames(entry, info)) return undefined;
      const parent = found.find((candidate) => candidate.pid === info!.parentPid && candidate.pid !== info!.pid);
      // A gone parent (its pid maybe reused since): orphaned.
      return parent && parent.createdMs <= info!.createdMs ? parent.pid : 0;
    } catch {
      return undefined;
    }
  }
  const pid = entry.pid;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    try {
      return Number(execFileSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8" }).trim()) || undefined;
    } catch {
      return undefined;
    }
  }
}
