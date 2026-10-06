import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { authFailureMessage, isAuthFailure, loginEnvironment, loginScript, loginWindow, offerLogin } from "../../src/claude/login.js";
import { Logger } from "../../src/log.js";

const logger = new Logger("error");
const home = process.env.CCODEX_HOME;

describe("Claude without a login", () => {
  afterEach(() => {
    loginWindow.offered = false;
    loginWindow.platform = process.platform;
    if (home === undefined) delete process.env.CCODEX_HOME;
    else process.env.CCODEX_HOME = home;
  });

  it("tells Claude's words for a missing or expired login from other errors", () => {
    for (const text of ["Claude error: authentication_failed", "Not logged in · Please run /login", "Please run /login",
      "Error: Authentication failed. Please check your API credentials.", "OAuth token has expired", "Invalid OAuth token"]) {
      expect(isAuthFailure(text), text).toBe(true);
    }
    for (const text of ["Claude error: rate_limit", "API Error: 529 overloaded", "Claude turn ended: error_max_turns", undefined]) {
      expect(isAuthFailure(text), String(text)).toBe(false);
    }
  });

  it("says how to sign in on each platform", () => {
    expect(authFailureMessage("win32")).toBe("Claude isn't signed in. Open Start menu → CCodex - Log in to Claude, then retry.");
    expect(authFailureMessage("darwin")).toBe("Claude isn't signed in. Run: ccodex auth claude, then retry.");
    expect(authFailureMessage("linux")).toBe("Claude isn't signed in. Run: ccodex auth claude, then retry.");
  });

  it("opens the login window once per process on Windows, only when the installer's script exists", () => {
    const root = mkdtempSync(join(tmpdir(), "ccodex-login-"));
    const open = vi.fn();
    loginWindow.open = open;
    loginWindow.platform = "win32";
    try {
      process.env.CCODEX_HOME = root;
      expect(loginScript()).toBe(join(root, "bin", "Log in to Claude.cmd"));
      mkdirSync(join(root, "bin"));
      writeFileSync(loginScript(), "@echo off\r\n");
      offerLogin(logger, "Not logged in · Please run /login");
      offerLogin(logger, "Claude error: authentication_failed");
      expect(open).toHaveBeenCalledTimes(1);
      expect(open).toHaveBeenCalledWith(loginScript());

      loginWindow.offered = false;
      rmSync(loginScript());
      offerLogin(logger, "Not logged in");
      expect(open).toHaveBeenCalledTimes(1);

      loginWindow.offered = false;
      loginWindow.platform = "darwin";
      writeFileSync(loginScript(), "");
      offerLogin(logger, "Not logged in");
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("starts the login without the Claude session it was found in", () => {
    const env = loginEnvironment({
      PATH: "p", USERPROFILE: "u", CLAUDE_CONFIG_DIR: "c", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "sdk-ts", CLAUDE_PID: "1",
      CLAUDE_AGENT_SDK_VERSION: "1", CLAUDE_CODE_CHILD_SESSION: "1", CLAUDE_CODE_HOST_PORT: "1", CLAUDE_CODE_MESSAGING_SOCKET: "x",
      CLAUDE_CODE_SESSION_ID: "s", CLAUDE_CODE_DESKTOP_PIPE: "d", CLAUDE_CODE_USE_BEDROCK: "1",
      // The gateway runs under the launcher; its guard would stop the login script's ccodex.exe.
      CCODEX_SHIM_ACTIVE: "1",
    });
    expect(env).toEqual({ PATH: "p", USERPROFILE: "u", CLAUDE_CONFIG_DIR: "c", CLAUDE_CODE_USE_BEDROCK: "1" });
  });
});
