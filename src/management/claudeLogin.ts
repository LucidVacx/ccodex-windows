/**
 * `ccodex auth claude` on Windows: Claude's own `auth login` on the real console (a TTY: its browser and localhost
 * callback flow, no code to paste), in an environment without another Claude Code session's host variables. A window
 * opened from inside a Claude Code session (the CLI, Desktop, an agent) inherits them, and Claude then runs as that
 * session's child or attached surface rather than a standalone login.
 */
import { spawn as spawnProcess } from "node:child_process";
import type { Writable } from "node:stream";

/**
 * Variables a Claude Code host session sets for the processes it starts (session identity, attachment, messaging,
 * bridge/background jobs), and Windows' SSH markers, which make Claude treat the console as remote. Not auth or config
 * the user chose: ANTHROPIC_*, CLAUDE_CONFIG_DIR, CLAUDE_CODE_OAUTH_TOKEN, BROWSER and proxies stay.
 */
const HOST_SESSION_VARIABLE = new RegExp(
  "^(?:CLAUDECODE|CLAUDE_PID|CLAUDE_AGENT_SDK_VERSION|CLAUDE_JOB_DIR|CLAUDE_BRIDGE_\\w+|CLAUDE_BG_\\w+"
  + "|CLAUDE_CODE_(?:ENTRYPOINT|EXECPATH|CHILD_SESSION|HOST_\\w+|MESSAGING_\\w+|SESSION_\\w+|DESKTOP_\\w+)"
  + "|SSH_CONNECTION|SSH_CLIENT|SSH_TTY)$",
  "iu",
);

/** `env` without host-session variables (and CCodex's shim guard): what a login started from the Start menu has. */
export function loginEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) => name !== "CCODEX_SHIM_ACTIVE" && !HOST_SESSION_VARIABLE.test(name)));
}

export interface LoginDeps {
  readonly spawn: typeof spawnProcess;
  readonly stdout: Writable;
}

export const LOGIN_NOTICE = "Your browser will open to sign in. If it doesn't, copy the link shown below into your browser.";

export function runClaudeLogin(command: string, args: readonly string[], deps: LoginDeps = { spawn: spawnProcess, stdout: process.stdout }): Promise<number> {
  deps.stdout.write(`${LOGIN_NOTICE}\n`);
  return new Promise((resolve, reject) => {
    const child = deps.spawn(command, [...args], { stdio: "inherit", env: loginEnvironment(process.env), windowsHide: true });
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
}
