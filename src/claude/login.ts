/** Claude Code without a login: a clear turn error, and on Windows its login window, offered once per gateway. */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join, win32 } from "node:path";
import { productHome } from "../config.js";
import { loginEnvironment as standaloneLoginEnvironment } from "../management/claudeLogin.js";
import type { Logger } from "../log.js";

/** Claude's words for a missing, invalid or expired login (its `authentication_failed` error, its result text). */
const AUTH_FAILURE = /authentication_failed|authentication failed|not logged in|please run \/login|(?:invalid|expired|revoked)[\w ]{0,20}oauth|oauth[\w ]{0,20}(?:invalid|expired|revoked)/iu;

export const isAuthFailure = (text: unknown): boolean => typeof text === "string" && AUTH_FAILURE.test(text);

export function authFailureMessage(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32"
    ? "Claude isn't signed in. Open Start menu → CCodex - Log in to Claude, then retry."
    : "Claude isn't signed in. Run: ccodex auth claude, then retry.";
}

/** The installer's login script (`<CCODEX_HOME>\bin\Log in to Claude.cmd`). */
export const loginScript = () => join(productHome(), "bin", "Log in to Claude.cmd");

/**
 * Without Claude host-session variables, and without the launcher's CCODEX_SHIM_ACTIVE (the gateway inherits it, and
 * the login script's ccodex.exe would refuse to start).
 */
export const loginEnvironment = (env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv => standaloneLoginEnvironment(env);

/** Opens the script in a console of its own (`start` makes it visible; the cmd that runs `start` stays hidden). */
function openConsole(script: string): void {
  const cmd = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe");
  // Node quotes each argument: `cmd.exe /d /c start "" "<script>"` (an empty window title, then the script).
  spawn(cmd, ["/d", "/c", "start", "", script], { env: loginEnvironment(), detached: true, stdio: "ignore", windowsHide: true }).unref();
}

export const loginWindow = { open: openConsole, platform: process.platform as NodeJS.Platform, offered: false };

/** Windows, once per process: the login window for an auth failure; nothing when the script is missing. */
export function offerLogin(logger: Logger, original: string): void {
  logger.warn("claude.auth.failed", { error: original });
  if (loginWindow.platform !== "win32" || loginWindow.offered) return;
  loginWindow.offered = true;
  const script = loginScript();
  if (!existsSync(script)) return;
  try {
    loginWindow.open(script);
    logger.info("claude.auth.login-opened", { script });
  } catch (error) {
    logger.warn("claude.auth.login-failed", { error: String(error) });
  }
}
