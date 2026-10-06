import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cpuSeconds, killProcesses, sessionProcesses } from "../../src/claude/processes.js";
import { registryEntry } from "../fixtures/platform.js";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const windows = process.platform === "win32";
const SLEEP = "setTimeout(() => {}, 30_000)";
const DETACH = `const c = require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(SLEEP)}], { detached: true, stdio: "ignore", windowsHide: true }); c.unref(); console.log(c.pid)`;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

describe("a Claude session's commands", () => {
  it("reads ps CPU times of Linux and macOS", () => {
    expect(cpuSeconds("00:01:05")).toBe(65);
    expect(cpuSeconds("2-01:00:00")).toBe(2 * 86_400 + 3_600);
    expect(cpuSeconds("0:03.25")).toBeCloseTo(3.25);
  });

  it("finds the commands still in the session's process tree, not one it detached", async () => {
    const session = `test-${process.pid}-${Date.now()}`;
    const env = { ...process.env, CLAUDE_CODE_SESSION_ID: session, CLAUDE_PID: String(process.pid) };
    // Windows lets no process read another's environment: the session is the one Claude's registry names for its pid.
    const claudeHome = windows ? mkdtempSync(join(tmpdir(), "ccodex-claude-sessions-")) : undefined;
    const configDir = process.env.CLAUDE_CONFIG_DIR;
    if (claudeHome) {
      mkdirSync(join(claudeHome, "sessions"));
      writeFileSync(join(claudeHome, "sessions", `${process.pid}.json`), JSON.stringify(registryEntry(process.pid, session)));
      process.env.CLAUDE_CONFIG_DIR = claudeHome;
    }
    // Windows: a command of Claude's Bash tool, by the marker its command line ends with (Claude saves the directory).
    const command = windows ? spawn(process.execPath, ["-e", SLEEP, "pwd -P >| cwd"], { env, windowsHide: true }) : spawn("sleep", ["30"], { env });
    // `nohup … &` from a shell: the command outlives the shell and is reparented away from the tree. Windows: a
    // detached command whose launcher has exited (its parent pid then names no live process).
    const detached = Number((windows
      ? spawnSync(process.execPath, ["-e", DETACH], { env, encoding: "utf8", windowsHide: true })
      : spawnSync("sh", ["-c", "sleep 30 >/dev/null 2>&1 & echo $!"], { env, encoding: "utf8" })).stdout.trim());
    try {
      await sleep(100);
      const found = (await sessionProcesses()).filter((entry) => entry.session === session).map((entry) => entry.pid);
      expect(found).toContain(command.pid);
      expect(found).not.toContain(detached);

      killProcesses([command.pid!]);
      // Windows ends the tree through taskkill, which takes longer than a signal (more so on a busy machine).
      if (windows) for (const deadline = Date.now() + 5_000; alive(command.pid!) && Date.now() < deadline;) await sleep(20);
      else await sleep(200);
      expect(alive(command.pid!)).toBe(false);
    } finally {
      command.kill("SIGKILL");
      try { process.kill(detached, "SIGKILL"); } catch { /* gone */ }
      if (claudeHome) {
        if (configDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
        else process.env.CLAUDE_CONFIG_DIR = configDir;
        rmSync(claudeHome, { recursive: true, force: true });
      }
    }
  });
});
