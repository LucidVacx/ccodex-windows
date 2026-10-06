// Platform seams of the test harness. On macOS/Linux every helper returns exactly what the tests used before.
import type * as ChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

export const isWindows = process.platform === "win32";

/**
 * A socket path for a test endpoint: `dir/name` on POSIX; on Windows (Node serves no filesystem sockets there) a named
 * pipe unique to this call, like the `\\.\pipe\ccodex-…` endpoint CCodex serves.
 */
export function testSocketPath(dir: string, name: string): string {
  if (!isWindows) return join(dir, name);
  return `\\\\.\\pipe\\ccodex-test-${randomUUID().slice(0, 12)}-${name.replace(/[\\/:*?"<>|]/gu, "_")}`;
}

/**
 * A Claude registry entry (`sessions/<pid>.json`) for `pid`: on Windows with its `procStart`, the process's creation
 * FILETIME (100 ns units) as Claude records it, without which CCodex takes the entry for a stale one.
 */
export function registryEntry(pid: number, sessionId: string): { pid: number; sessionId: string; procStart?: string } {
  if (!isWindows) return { pid, sessionId };
  // Not imported: tests mock node:child_process with `runNodeScripts`, whose factory imports this module.
  const { spawnSync } = process.getBuiltinModule("node:child_process");
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    `(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToFileTimeUtc()`], { encoding: "utf8", windowsHide: true });
  const procStart = result.stdout.trim();
  if (!/^\d+$/u.test(procStart)) throw new Error(`no creation time for process ${pid}: ${result.stderr.trim()}`);
  return { pid, sessionId, procStart };
}

/**
 * Writes a fake executable: on POSIX the `#!/bin/sh` script `sh` at `path` (mode 0700); on Windows, which runs no
 * shebang scripts, the Node script `node` at `path.mjs`, which `runNodeScripts` has node run. Returns the path written.
 */
export function writeExecutable(path: string, scripts: { sh: string; node: string }): string {
  if (!isWindows) {
    writeFileSync(path, `#!/bin/sh\n${scripts.sh}`, { mode: 0o700 });
    chmodSync(path, 0o700);
    return path;
  }
  writeFileSync(`${path}.mjs`, scripts.node);
  return `${path}.mjs`;
}

/**
 * For `vi.mock("node:child_process", …)`: on Windows a spawned `.mjs`/`.js` fake executable runs as `node <script> …args`
 * (CCodex spawns codex without a shell, and Windows cannot exec a script). POSIX gets the module unchanged.
 */
export function runNodeScripts(actual: typeof ChildProcess): typeof ChildProcess {
  if (!isWindows) return actual;
  const route = (rest: unknown[]): unknown[] => {
    const [file, args, ...more] = rest;
    return typeof file === "string" && /\.m?js$/iu.test(file)
      ? [process.execPath, [file, ...(Array.isArray(args) ? args : [])], ...(Array.isArray(args) ? more : [args, ...more])]
      : rest;
  };
  const call = <F extends (...args: any[]) => any>(original: F) => ((...rest: unknown[]) => original(...route(rest))) as unknown as F;
  const execFile = call(actual.execFile);
  const custom = (actual.execFile as unknown as Record<symbol, (...args: unknown[]) => unknown>)[promisify.custom]!;
  Object.defineProperty(execFile, promisify.custom, { value: (...rest: unknown[]) => custom(...route(rest)) });
  return {
    ...actual,
    spawn: call(actual.spawn),
    spawnSync: call(actual.spawnSync),
    execFile,
    execFileSync: call(actual.execFileSync),
  };
}
