import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { isWindows } from "../platform/process.js";

function refuseManagedEntrypoint(command: string): void {
  if (!existsSync(command)) return;
  const home = resolve(process.env.CCODEX_HOME ?? join(homedir(), ".ccodex"));
  const own = realpathSync(command);
  const managed = [
    process.argv[1],
    join(home, "bin", "codex"),
    join(home, "bin", "ccodex"),
    join(home, "current", "node_modules", ".bin", "ccodex"),
  ].filter((path): path is string => typeof path === "string" && existsSync(path));
  if (managed.some((path) => realpathSync(path) === own)) {
    throw new Error(`Refusing recursive delegation to managed CCodex entrypoint '${command}'.`);
  }
}

export function delegate(command: string, args: readonly string[]): Promise<number> {
  refuseManagedEntrypoint(command);
  const env = { ...process.env };
  delete env.CCODEX_SHIM_ACTIVE;
  delete env.CODEX_CLI_PATH;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      env,
      stdio: "inherit",
      // No console window flashing up for a non-interactive run; an interactive one keeps its terminal.
      windowsHide: !process.stdin.isTTY,
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      // Windows has no signal to re-raise: a signalled child (only one we killed) reports failure.
      if (signal && !isWindows) {
        process.kill(process.pid, signal);
        return;
      }
      resolve(code ?? 1);
    });
  });
}
