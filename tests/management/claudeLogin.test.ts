import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { LOGIN_NOTICE, loginEnvironment, runClaudeLogin } from "../../src/management/claudeLogin.js";
import { relayHost, relayWarning } from "../../src/management/claudeRelay.js";

describe("a third-party Claude endpoint", () => {
  it("is the host of a non-Anthropic ANTHROPIC_BASE_URL in settings' env", () => {
    expect(relayHost({ env: { ANTHROPIC_BASE_URL: "https://relay.example.com/", ANTHROPIC_AUTH_TOKEN: "sk-secret" } })).toBe("relay.example.com");
    expect(relayHost({ env: { ANTHROPIC_BASE_URL: " http://10.0.0.5:8080/v1 " } })).toBe("10.0.0.5");
    expect(relayHost({ env: { ANTHROPIC_BASE_URL: "not a url" } })).toBe("an unrecognised address");
  });

  it("is none for Anthropic's own hosts, or without the variable", () => {
    expect(relayHost({ env: { ANTHROPIC_BASE_URL: "https://api.anthropic.com" } })).toBeUndefined();
    expect(relayHost({ env: { ANTHROPIC_BASE_URL: "https://anthropic.com/" } })).toBeUndefined();
    expect(relayHost({ env: { ANTHROPIC_BASE_URL: "https://anthropic.com.evil.example/" } })).toBe("anthropic.com.evil.example");
    expect(relayHost({ env: { OTHER: "x" } })).toBeUndefined();
    expect(relayHost({ env: null })).toBeUndefined();
    expect(relayHost(undefined)).toBeUndefined();
    expect(relayHost({ env: { ANTHROPIC_BASE_URL: 5 } })).toBeUndefined();
  });

  it("is warned about by host only, never the token", () => {
    const warning = relayWarning("relay.example.com", "C:\\Users\\u\\.claude\\settings.json", "ccodex auth claude");
    expect(warning).toContain("relay.example.com");
    expect(warning).toContain("not an Anthropic (claude.ai) login");
    expect(warning).not.toMatch(/sk-|TOKEN=/u);
  });
});

describe("ccodex auth claude on Windows", () => {
  let root: string | undefined;
  afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

  it("drops a host Claude session's variables, never the user's auth or config", () => {
    const env = loginEnvironment({
      CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "claude-desktop", CLAUDE_CODE_HOST_SESSION_ID: "h", CLAUDE_CODE_MESSAGING_SOCKET: "s",
      CLAUDE_CODE_MESSAGING_TOKEN: "t", CLAUDE_CODE_SESSION_ID: "x", CLAUDE_CODE_SESSION_ATTENDED: "1", CLAUDE_CODE_CHILD_SESSION: "1",
      CLAUDE_CODE_DESKTOP_APP_VERSION: "1", CLAUDE_CODE_EXECPATH: "c", CLAUDE_PID: "9", CLAUDE_AGENT_SDK_VERSION: "0.3",
      CLAUDE_BRIDGE_REATTACH_SESSION: "r", CLAUDE_JOB_DIR: "j", SSH_CONNECTION: "a b", SSH_TTY: "t", CCODEX_SHIM_ACTIVE: "1",
      ANTHROPIC_BASE_URL: "https://relay.example", ANTHROPIC_API_KEY: "k", CLAUDE_CONFIG_DIR: "C:\\c", CLAUDE_CODE_OAUTH_TOKEN: "o",
      BROWSER: "firefox", HTTPS_PROXY: "http://p", PATH: "C:\\bin",
    });
    expect(Object.keys(env).sort()).toEqual(
      ["ANTHROPIC_API_KEY", "ANTHROPIC_BASE_URL", "BROWSER", "CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR", "HTTPS_PROXY", "PATH"]);
  });

  it("runs Claude's login on the inherited console, says what happens first, and returns its exit code", async () => {
    root = mkdtempSync(join(tmpdir(), "ccodex-login-"));
    const report = join(root, "env.json");
    const fake = join(root, "fake-claude.cjs");
    writeFileSync(fake, `require("fs").writeFileSync(${JSON.stringify(report)}, JSON.stringify({ args: process.argv.slice(2), host: process.env.CLAUDECODE ?? null, base: process.env.ANTHROPIC_BASE_URL ?? null })); process.exit(5);`);
    const saved = { ...process.env };
    process.env.CLAUDECODE = "1";
    process.env.ANTHROPIC_BASE_URL = "https://relay.example";
    const spawned: { stdio?: unknown }[] = [];
    const stdout = new PassThrough();
    let out = "";
    stdout.on("data", (chunk) => { out += chunk; });
    try {
      const code = await runClaudeLogin(process.execPath, [fake, "auth", "login"], {
        stdout,
        spawn: ((command: string, args: string[], options: { stdio?: unknown }) => {
          spawned.push(options);
          return spawn(command, args, options as never);
        }) as never,
      });
      expect(code).toBe(5);
    } finally {
      process.env = saved;
    }
    expect(spawned[0]?.stdio).toBe("inherit");
    expect(out).toBe(`${LOGIN_NOTICE}\n`);
    expect(JSON.parse(readFileSync(report, "utf8"))).toEqual({ args: ["auth", "login"], host: null, base: "https://relay.example" });
  });
});
