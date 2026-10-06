import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, renameSync, rmSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { promisify } from "node:util";
import { delegate } from "../cli/delegate.js";
import { claudeHome, defaultConfigToml, defaultPublicSocket, displacedCodexPath, findInstalledCodex, isCcodex, productHome, remoteCodexPath, type Config } from "../config.js";
import { probeAppServer } from "../daemon/probe.js";
import { reconcileManagedProcess, stopManagedProcess } from "../daemon/supervisor.js";
import { reconcileOwnedGateway, stopSocketOwner } from "../daemon/ownership.js";
import { installCliPathAgent, uninstallCliPathAgent, type CliPathAgentInstall } from "../desktop/launchAgent.js";
import { relayBinary } from "../gateway/remote.js";
import { isProcessAlive, isWindows } from "../platform/process.js";
import { atomicSymlink, atomicWrite } from "./files.js";
import { compareSemver } from "./shimSelect.js";
import { claudeSettingsPath, configuredRelayHost, relayWarning } from "./claudeRelay.js";
import { runClaudeLogin } from "./claudeLogin.js";
import {
  applyWindowsEnvironment, backupFile, commandHint, installLaunchers, installLoginShortcut, loginHint, removeLoginShortcut,
  removeStaleInstalls, restoreWindowsEnvironment, type WindowsEnvironment, type WindowsLogin,
} from "./windows.js";

const execute = promisify(execFile);

/** Windows' `npm` is a `.cmd` that execFile cannot run without a shell: run npm's own script with this Node. */
function npm(args: readonly string[], options: { timeout: number; maxBuffer?: number }) {
  if (!isWindows) return execute("npm", args, options);
  const cli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (!existsSync(cli)) throw new Error(`npm not found beside ${process.execPath} (expected ${cli})`);
  return execute(process.execPath, [cli, ...args], { ...options, windowsHide: true });
}

/** `npm root -g` (where a newer global CCodex would be), for the Windows launcher's sidecar; best effort. */
async function npmGlobalRoot(): Promise<string | undefined> {
  try {
    return (await npm(["root", "-g"], { timeout: 30_000 })).stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
const PACKAGE = "@gkorepanov/ccodex";
const BEGIN = "# >>> ccodex >>>";
const END = "# <<< ccodex <<<";

/** `~/.ccodex/install.json`, kept compatible with 0.4 so upgrades and uninstall keep working. */
interface Manifest {
  readonly schemaVersion: 1;
  readonly package: typeof PACKAGE;
  readonly activeVersion: string;
  readonly delegateCodex?: string | null;
  readonly publicSocket?: string;
  readonly managedShellFiles: string[];
  readonly shimHashes: Record<string, string>;
  readonly remoteCodexShim?: { path: string; target: string; backupPath?: string };
  readonly desktopCliPath?: CliPathAgentInstall;
  /** Windows: the user environment setup changed (CODEX_CLI_PATH, PATH), for uninstall. */
  readonly windowsEnvironment?: WindowsEnvironment;
  /** Windows: the "Log in to Claude" script and its Start menu entry. */
  readonly windowsLogin?: WindowsLogin;
  readonly nodeExecutable: string;
  readonly installedAt: string;
}

const layout = () => {
  const home = productHome();
  return {
    home, bin: join(home, "bin"), versions: join(home, "versions"), state: join(home, "state"),
    current: join(home, "current"), manifest: join(home, "install.json"),
  };
};

export function packageVersion(): string {
  return (JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { version: string }).version;
}

function readManifest(): Manifest | undefined {
  const path = layout().manifest;
  return existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Manifest : undefined;
}

/** `ccodex …`/`codex …` as a user can run it now: on Windows by full path while this terminal lacks it on PATH. */
const hint = (name: "ccodex" | "codex", args: string) => isWindows ? commandHint(layout().bin, name, args) : `${name} ${args}`;
const claudeLoginHint = () => isWindows ? loginHint(layout().bin) : "ccodex auth claude";

const daemonPidFile = () => join(process.env.CODEX_HOME ?? join(homedir(), ".codex"), "app-server-daemon", "app-server.pid");

/** The running CCodex gateway (the daemon's, or one serving `publicSocket`), with how to stop it. */
function runningGateway(publicSocket: string | undefined): { pid: number; stop: () => Promise<void> } | undefined {
  const pidFile = daemonPidFile();
  const managed = reconcileManagedProcess(pidFile);
  if (managed) return { pid: managed.pid, stop: () => stopManagedProcess(pidFile, managed) };
  const owner = publicSocket ? reconcileOwnedGateway(publicSocket) : undefined;
  return owner && publicSocket ? { pid: owner.pid, stop: () => stopSocketOwner(publicSocket, owner) } : undefined;
}

/** A yes/no question on the console; `fallback` without one (scripts, --yes). */
async function confirm(question: string, fallback: boolean): Promise<boolean> {
  if (!process.stdin.isTTY) return fallback;
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return !/^\s*n/iu.test(await prompt.question(question));
  } finally {
    prompt.close();
  }
}

/**
 * Windows locks the files a running gateway (its Claude processes) uses, so replacing its version needs it stopped
 * first. The Codex app starts it again while open: it should be quit before.
 */
async function stopGatewayForReplacement(publicSocket: string | undefined, assumeYes: boolean): Promise<void> {
  const gateway = runningGateway(publicSocket);
  if (!gateway) return;
  process.stdout.write(`The CCodex gateway is running (pid ${gateway.pid}) and uses the files this setup replaces, so it has to stop.\n`
    + "Open Codex app chats will disconnect. Quit the Codex app first, or it starts the gateway again.\n");
  if (!assumeYes && !await confirm("Stop the gateway and continue? [Y/n] ", true)) {
    throw new Error("Setup cancelled; nothing was changed.");
  }
  await gateway.stop();
  process.stdout.write("Stopped the CCodex gateway.\n");
}

/** Windows: the version directory replaced by renaming (a locked file fails the rename, not half a delete). */
function replaceVersion(temporary: string, target: string, version: string): void {
  if (!isWindows) {
    rmSync(target, { recursive: true, force: true });
    renameSync(temporary, target);
    return;
  }
  const aside = `${target}.old-${process.pid}`;
  try {
    if (existsSync(target)) renameSync(target, aside);
  } catch (error) {
    rmSync(temporary, { recursive: true, force: true });
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES") throw error;
    throw new Error(`CCodex ${version} is in use (${code}): quit the Codex app, run ${hint("codex", "app-server daemon stop")}, then run setup again.`);
  }
  renameSync(temporary, target);
  try { rmSync(aside, { recursive: true, force: true }); } catch { /* removed by the next setup */ }
}

const sha256 = (content: string | Buffer) => createHash("sha256").update(content).digest("hex");
const quote = (value: string) => `'${value.replaceAll("'", "'\"'\"'")}'`;

function shim(name: "codex" | "ccodex", node: string): string {
  const prelude = `#!/bin/sh
set -eu
if [ "\${CCODEX_SHIM_ACTIVE:-}" = 1 ]; then
  printf '%s\\n' 'CCodex recursion guard: managed shim attempted to invoke itself.' >&2
  exit 70
fi
CCODEX_SHIM_ACTIVE=1
CCODEX_HOME=\${CCODEX_HOME:-"$HOME/.ccodex"}
CCODEX_NODE=${quote(node)}
if [ ! -x "$CCODEX_NODE" ]; then
  CCODEX_NODE=$(command -v node 2>/dev/null || true)
fi
if [ -z "$CCODEX_NODE" ] || [ ! -x "$CCODEX_NODE" ]; then
  printf '%s\\n' 'CCodex Node runtime is missing. Reinstall Node.js, then run: npm install -g ${PACKAGE} && ccodex setup' >&2
  exit 69
fi
export CCODEX_SHIM_ACTIVE CCODEX_HOME
`;
  const current = `exec "$CCODEX_NODE" "$CCODEX_HOME/current/node_modules/${PACKAGE}/dist/cli/main.js" "$@"\n`;
  if (name === "codex") return `${prelude}${current}`;
  // Management commands prefer a newer globally installed package (npm i -g → ccodex setup).
  return `${prelude}case "\${1:-}" in
  setup|update|uninstall|doctor|auth)
    global_package="$(npm root -g 2>/dev/null || true)/${PACKAGE}"
    if [ -f "$global_package/dist/cli/main.js" ] && "$CCODEX_NODE" "$global_package/dist/management/shimSelect.js" "$CCODEX_HOME/current/node_modules/${PACKAGE}/package.json"; then
      exec "$CCODEX_NODE" "$global_package/dist/cli/main.js" "$@"
    fi
    ;;
esac
${current}`;
}

function shellBlock(fish: boolean, bin: string): string {
  const cliPath = process.platform === "darwin"
    ? fish ? `set -gx CODEX_CLI_PATH "${bin}/codex"\n` : `export CODEX_CLI_PATH="${bin}/codex"\n`
    : "";
  return `${BEGIN}\n${fish ? `fish_add_path --move --prepend "${bin}"` : `export PATH="${bin}:$PATH"`}\n${cliPath}${END}\n`;
}

const BLOCK_PATTERN = new RegExp(`${BEGIN}\\n[\\s\\S]*?${END}\\n?`, "u");

function shellFiles(): string[] {
  const home = homedir();
  const login = existsSync(join(home, ".bash_profile")) ? join(home, ".bash_profile") : join(home, ".profile");
  return [login, join(home, ".bashrc"), join(home, ".zprofile"), join(home, ".zshrc"), join(home, ".config", "fish", "config.fish")];
}

function writeShellBlock(path: string, bin: string): void {
  const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block = shellBlock(path.endsWith(".fish"), bin);
  const next = BLOCK_PATTERN.test(existing)
    ? existing.replace(BLOCK_PATTERN, block)
    : `${existing}${existing && !existing.endsWith("\n") ? "\n" : ""}${block}`;
  if (next !== existing) atomicWrite(path, next, existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
}

/**
 * `~/.local/bin/codex` → the managed shim: Desktop over SSH puts that directory first on PATH. A codex found there
 * (Codex's installer puts it there, also over our link) moves aside and stays CCodex's stock codex.
 */
/** 0.4 moved an installer's relative `codex` link into the backup as is, where it dangles: it points again where it did. */
function healDisplacedCodex(home: string): void {
  const backupPath = displacedCodexPath(home);
  if (existsSync(backupPath) || !lstatSync(backupPath, { throwIfNoEntry: false })?.isSymbolicLink()) return;
  const target = resolve(dirname(remoteCodexPath()), readlinkSync(backupPath));
  if (existsSync(target)) atomicSymlink(target, backupPath);
}

function installRemoteShim(home: string, bin: string): Manifest["remoteCodexShim"] {
  const path = remoteCodexPath();
  const target = join(bin, "codex");
  if (path === target) return undefined;
  const backupPath = displacedCodexPath(home);
  if (existsSync(path) && !isCcodex(path, home)) {
    mkdirSync(dirname(backupPath), { recursive: true, mode: 0o700 });
    // The installer's link points at `…/standalone/current/…`, which follows its updates: keep pointing there.
    if (lstatSync(path).isSymbolicLink()) atomicSymlink(resolve(dirname(path), readlinkSync(path)), backupPath);
    else renameSync(path, backupPath);
  }
  mkdirSync(dirname(path), { recursive: true });
  atomicSymlink(target, path);
  return { path, target, ...(existsSync(backupPath) ? { backupPath } : {}) };
}

/** scripts/install-claude-stack.sh, in Node: Windows has no `sh`. */
function installClaudeStackWindows(packageRoot: string, bin: string): void {
  const claudeDir = process.env.CLAUDE_DIR ?? join(homedir(), ".claude");
  mkdirSync(join(claudeDir, "agents"), { recursive: true });
  copyFileSync(join(packageRoot, "agents", "codex-wrapper.md"), join(claudeDir, "agents", "codex-wrapper.md"));
  process.stdout.write(`installed agent: codex-wrapper -> ${join(claudeDir, "agents", "codex-wrapper.md")}\n`);
  if (existsSync(join(claudeDir, "skills", "workforce"))) {
    process.stdout.write(`The workforce skill has become outdated and CCodex no longer manages it. Remove ${join(claudeDir, "skills", "workforce")}, or keep managing it yourself.\n`);
  }
  const configDir = process.env.CLAUDE_CONFIG_DIR;
  const legacyPath = join(configDir || join(homedir(), ".claude"), ".config.json");
  const configPath = existsSync(legacyPath) ? legacyPath : join(configDir || homedir(), ".claude.json");
  type Server = { command?: string; timeout?: number };
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) as { mcpServers?: Record<string, Server> } : {};
  const server = config.mcpServers?.codex;
  const timeout = Math.max(server?.timeout ?? 0, 86_400_000);
  // Claude may not find a bare `codex` (a PATH change reaches new processes only): name the launcher. A command the
  // user chose stays.
  const launcher = join(bin, "codex.exe");
  const command = server?.command === undefined || /^codex(?:\.exe)?$/iu.test(server.command) ? launcher : server.command;
  if (server?.timeout !== timeout || server.command !== command) {
    config.mcpServers = { ...config.mcpServers, codex: server ? { ...server, command, timeout } : { type: "stdio", command, args: ["mcp-server"], env: {}, timeout } as Server };
    backupFile(configPath);
    atomicWrite(configPath, `${JSON.stringify(config, null, 2)}\n`, existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600);
  }
  process.stdout.write("codex MCP server: configured (user scope, timeout at least 24 hours)\n");
}

/** Claude's side of delegation to Codex: the codex-wrapper agent and the codex MCP server. */
async function installClaudeStack(packageRoot: string, bin: string): Promise<void> {
  try {
    if (isWindows) return installClaudeStackWindows(packageRoot, bin);
    const env = { ...process.env, PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ""}` };
    const { stdout } = await execute("sh", [join(packageRoot, "scripts", "install-claude-stack.sh")], { env, timeout: 60_000, maxBuffer: 512 * 1024 });
    process.stdout.write(stdout);
  } catch (error) {
    process.stderr.write(`CCodex setup warning: Claude delegation stack install failed: ${String(error)}\n`);
  }
}

/** CCodex's Claude chats are Claude's transcripts, which Claude deletes after `cleanupPeriodDays` (30 by default). */
function keepClaudeTranscripts(): void {
  const path = join(claudeHome(), "settings.json");
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown> : {};
  if (settings.cleanupPeriodDays !== undefined) return;
  mkdirSync(dirname(path), { recursive: true });
  if (isWindows) backupFile(path);
  atomicWrite(path, `${JSON.stringify({ ...settings, cleanupPeriodDays: 36_500 }, null, 2)}\n`, existsSync(path) ? statSync(path).mode & 0o777 : 0o600);
  process.stdout.write(`Set cleanupPeriodDays: 36500 in ${path}: Claude deletes older transcripts, and with them CCodex's Claude chats.\n`);
}

export async function setup(args: readonly string[]): Promise<number> {
  if (process.getuid?.() === 0) throw new Error("Do not run CCodex setup as root or with sudo.");
  const versionIndex = args.indexOf("--version");
  const version = versionIndex >= 0 ? args[versionIndex + 1] : packageVersion();
  if (!version) throw new Error("Usage: ccodex setup [--version VERSION] [--repair]");
  const paths = layout();
  for (const directory of [paths.home, paths.bin, paths.versions, paths.state]) mkdirSync(directory, { recursive: true, mode: 0o700 });
  const target = join(paths.versions, version);
  if (isWindows) removeStaleInstalls(paths.versions, isProcessAlive);
  if (!existsSync(target) || args.includes("--repair")) {
    if (isWindows && existsSync(target)) await stopGatewayForReplacement(readManifest()?.publicSocket ?? defaultPublicSocket(), args.includes("--yes"));
    const temporary = `${target}.installing-${process.pid}`;
    rmSync(temporary, { recursive: true, force: true });
    // Dev builds (never published) come as tarballs: the package and its platform relay package.
    const specs = [process.env.CCODEX_PACKAGE_SPEC ?? `${PACKAGE}@${version}`, ...(process.env.CCODEX_RELAY_PACKAGE_SPEC ? [process.env.CCODEX_RELAY_PACKAGE_SPEC] : [])];
    process.stdout.write(`Installing ${specs.join(" ")} into ${target}\n`);
    try {
      await npm(["install", "--prefix", temporary, "--include=optional", "--ignore-scripts", "--save=false", "--no-audit", "--no-fund", ...specs], {
        timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024,
      });
    } catch (error) {
      rmSync(temporary, { recursive: true, force: true });
      throw error;
    }
    replaceVersion(temporary, target, version);
    // The cached Claude model list may come from another login or endpoint: the next gateway lists them afresh.
    if (isWindows) rmSync(join(paths.state, "claude-models.json"), { force: true });
  }
  // The version being activated finishes its own setup (shims and layout are its business).
  if (version !== packageVersion()) {
    const cli = join(target, "node_modules", PACKAGE, "dist", "cli", "main.js");
    const child = spawn(process.execPath, [cli, "setup", "--version", version], { stdio: "inherit", windowsHide: true });
    return new Promise((done, fail) => {
      child.once("error", fail);
      child.once("exit", (code) => done(code ?? 1));
    });
  }
  keepClaudeTranscripts();
  healDisplacedCodex(paths.home);
  // CCodex runs the Codex that is installed (like install.sh, it installs one when there is none).
  if (!findInstalledCodex(paths.home)) {
    process.stdout.write("No codex on PATH: installing @openai/codex\n");
    await npm(["install", "-g", "@openai/codex@latest", "--no-audit", "--no-fund"], { timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  }
  // 0.4 kept its threads in state.sqlite, 0.5 reads Claude's transcripts plus meta.json: migrate once, before activating.
  if (existsSync(join(paths.state, "state.sqlite")) && !existsSync(join(paths.state, "meta.json"))) {
    const migration = spawn(process.execPath, [join(target, "node_modules", PACKAGE, "scripts", "migrate-0.4-to-0.5.mjs")], { stdio: "inherit", windowsHide: true });
    const code = await new Promise<number>((done, fail) => {
      migration.once("error", fail);
      migration.once("exit", (exit) => done(exit ?? 1));
    });
    if (code !== 0) throw new Error(`Migrating CCodex 0.4 threads failed (exit ${code}); nothing was activated.`);
  }
  const previous = readManifest();
  atomicSymlink(join("versions", version), paths.current);
  const packageRoot = join(target, "node_modules", PACKAGE);
  let shimHashes: Record<string, string> = {};
  let managedShellFiles: string[] = [];
  let remoteCodexShim: Manifest["remoteCodexShim"];
  let windowsEnvironment: WindowsEnvironment | undefined;
  let windowsLogin: WindowsLogin | undefined;
  if (isWindows) {
    // `codex.exe`/`ccodex.exe` launchers and the user environment stand in for the shims and shell rc blocks; Desktop
    // over SSH (the ~/.local/bin shim) does not reach Windows.
    shimHashes = installLaunchers(paths.bin, packageRoot, paths.home, await npmGlobalRoot());
    windowsEnvironment = applyWindowsEnvironment(paths.bin, previous?.windowsEnvironment);
    const login = installLoginShortcut(paths.bin);
    windowsLogin = login.login;
    shimHashes[basename(login.login.cmd)] = login.hash;
  } else {
    for (const name of ["codex", "ccodex"] as const) {
      const content = shim(name, process.execPath);
      atomicWrite(join(paths.bin, name), content, 0o755);
      shimHashes[name] = sha256(content);
    }
    managedShellFiles = shellFiles();
    for (const path of managedShellFiles) writeShellBlock(path, paths.bin);
    remoteCodexShim = installRemoteShim(paths.home, paths.bin);
  }
  const configPath = join(paths.home, "config.toml");
  if (!existsSync(configPath)) atomicWrite(configPath, defaultConfigToml(), 0o600);
  const desktopCliPath = process.platform === "darwin" ? installCliPathAgent(join(paths.bin, "codex"), previous?.desktopCliPath) : undefined;
  const manifest: Manifest = {
    schemaVersion: 1,
    package: PACKAGE,
    activeVersion: version,
    delegateCodex: previous?.delegateCodex ?? null,
    publicSocket: previous?.publicSocket ?? defaultPublicSocket(),
    managedShellFiles,
    shimHashes,
    ...(remoteCodexShim ? { remoteCodexShim } : {}),
    ...(desktopCliPath ? { desktopCliPath } : {}),
    ...(windowsEnvironment ? { windowsEnvironment } : {}),
    ...(windowsLogin ? { windowsLogin } : {}),
    nodeExecutable: process.execPath,
    installedAt: new Date().toISOString(),
  };
  atomicWrite(paths.manifest, `${JSON.stringify(manifest, null, 2)}\n`, 0o600);
  // Old versions stay only as long as they are the one just replaced.
  for (const name of readdirSync(paths.versions)) {
    if (name !== version && name !== previous?.activeVersion) rmSync(join(paths.versions, name), { recursive: true, force: true });
  }
  for (const stale of ["staging", "previous"]) rmSync(join(paths.home, stale), { recursive: true, force: true });
  await installClaudeStack(packageRoot, paths.bin);
  if (isWindows) {
    const relay = configuredRelayHost();
    if (relay) process.stderr.write(`\n${relayWarning(relay, claudeSettingsPath(), claudeLoginHint())}\n\n`);
  }
  // Read from the activated version: 0.4 hands over to this setup from ~/.ccodex/staging, removed above.
  process.stdout.write(`CCodex ${version} activated. Restart the gateway: ${hint("codex", "app-server daemon restart")}\n`
    + (isWindows
      ? "Quit and reopen the Codex app (it reads CODEX_CLI_PATH when it starts); its first Claude model list can take about 10 seconds.\n"
        + `Log in to Claude: ${claudeLoginHint()}\n`
        + "Open a NEW terminal window (close all Windows Terminal windows first) to use `ccodex`/`codex` by name.\n"
      : `Open a new shell or run: export PATH="${paths.bin}:$PATH"\n`));
  return 0;
}

export async function update(args: readonly string[]): Promise<number> {
  const channel = args.includes("--next") ? "next" : "latest";
  const { stdout } = await npm(["view", PACKAGE, `dist-tags.${channel}`, "--json"], { timeout: 30_000 });
  const latest = JSON.parse(stdout) as string;
  const current = readManifest()?.activeVersion;
  if (current && compareSemver(latest, current) <= 0) {
    process.stdout.write(`CCodex ${current} is current.\n`);
    return 0;
  }
  if (args.includes("--check")) {
    process.stdout.write(`CCodex ${latest} is available (current: ${current ?? "none"}).\n`);
    return 0;
  }
  return setup(["--version", latest]);
}

export async function uninstall(args: readonly string[]): Promise<number> {
  const purge = args.includes("--purge");
  if (purge && !args.includes("--yes")) throw new Error(`Purging removes all CCodex state. Confirm with: ${hint("ccodex", "uninstall --purge --yes")}`);
  const paths = layout();
  const manifest = readManifest();
  if (!manifest) throw new Error("CCodex is not activated.");
  await runningGateway(manifest.publicSocket)?.stop();
  for (const path of manifest.managedShellFiles) {
    if (!existsSync(path)) continue;
    const content = readFileSync(path, "utf8");
    if (BLOCK_PATTERN.test(content)) atomicWrite(path, content.replace(BLOCK_PATTERN, ""), statSync(path).mode & 0o777);
  }
  const remote = manifest.remoteCodexShim;
  if (remote && existsSync(remote.path) && lstatSync(remote.path).isSymbolicLink()) {
    rmSync(remote.path);
    if (remote.backupPath && existsSync(remote.backupPath)) renameSync(remote.backupPath, remote.path);
  }
  if (manifest.desktopCliPath) uninstallCliPathAgent(manifest.desktopCliPath);
  if (manifest.windowsEnvironment) restoreWindowsEnvironment(manifest.windowsEnvironment);
  if (manifest.windowsLogin) removeLoginShortcut(manifest.windowsLogin);
  // Windows cannot delete a running exe (the launcher this uninstall may run under): what stays is reported.
  const remove = (path: string, recursive = false) => {
    try {
      rmSync(path, { recursive, force: true });
    } catch (error) {
      if (!isWindows) throw error;
      process.stderr.write(`CCodex uninstall: could not remove ${path} (in use?); delete it once nothing runs it.\n`);
    }
  };
  for (const name of Object.keys(manifest.shimHashes)) remove(join(paths.bin, name));
  for (const path of [paths.current, join(paths.home, "previous"), paths.versions, join(paths.home, "staging"), paths.manifest, paths.bin]) {
    remove(path, true);
  }
  if (purge) remove(paths.home, true);
  process.stdout.write(purge ? "CCodex uninstalled and state purged.\n" : `CCodex uninstalled; state kept in ${paths.state}.\n`);
  return 0;
}

async function version(command: string, args: readonly string[]): Promise<string> {
  const { stdout, stderr } = await execute(command, args, { timeout: 15_000, windowsHide: true });
  return `${stdout}${stderr}`.trim().split("\n")[0]!;
}

/** Minimal health report: runtimes, auth, relay, gateway. */
export async function doctor(config: Config, json: boolean): Promise<number> {
  const check = async (id: string, run: () => Promise<string> | string): Promise<{ id: string; ok: boolean; detail: string }> => {
    try {
      return { id, ok: true, detail: await run() };
    } catch (error) {
      return { id, ok: false, detail: error instanceof Error ? error.message.split("\n")[0]! : String(error) };
    }
  };
  const relay = configuredRelayHost();
  const checks = await Promise.all([
    check("node", () => process.version),
    check("codex", async () => `${config.codex} (${await version(config.codex, ["--version"])})`),
    check("codex-auth", async () => {
      const status = await version(config.codex, ["login", "status"]);
      if (/not logged in/iu.test(status)) throw new Error(`${status} → run: ${hint("ccodex", "auth codex")}`);
      return status;
    }),
    check("claude", async () => `${config.claudeBinary} (${await version(config.claudeBinary, ["--version"])})`),
    check("claude-auth", async () => {
      const status = await claudeAuthStatus(config);
      if (!status.loggedIn) throw new Error(`not logged in → ${claudeLoginHint()}`);
      return `${status.email ?? "logged in"} (${status.authMethod ?? "unknown"})`;
    }),
    // Warns only: a third-party ANTHROPIC_BASE_URL in Claude's settings (host only: its env block carries a token).
    check("claude-endpoint", () => {
      if (relay) throw new Error(`third-party endpoint ${relay} (ANTHROPIC_BASE_URL in ${claudeSettingsPath()}), not an Anthropic login; see below`);
      return "Anthropic";
    }),
    check("relay", () => {
      if (process.platform === "win32") return "not supported on Windows (mobile remote control is off)";
      const binary = relayBinary();
      if (!existsSync(binary)) throw new Error(`missing: ${binary}`);
      return binary;
    }),
    check("gateway", async () => {
      await probeAppServer(config.publicSocket);
      return `listening on ${config.publicSocket}`;
    }),
    check("install", () => {
      const manifest = readManifest();
      if (!manifest) throw new Error(`not activated → run: ${hint("ccodex", "setup")}`);
      const remote = manifest.remoteCodexShim;
      // Codex's installer (or Desktop's "Update Codex") puts its own codex there, and SSH sessions skip CCodex.
      if (remote && !(existsSync(remote.path) && isCcodex(remote.path))) throw new Error(`${remote.path} is not CCodex, Desktop over SSH bypasses it → run: ${hint("ccodex", "setup")}`);
      return `${manifest.activeVersion} (${basename(readlinkSync(layout().current))})`;
    }),
  ]);
  const counts = (item: { id: string; ok: boolean }) => item.ok || item.id === "gateway" || item.id === "claude-endpoint";
  if (json) process.stdout.write(`${JSON.stringify({ ok: checks.every(counts), checks }, null, 2)}\n`);
  else {
    for (const item of checks) process.stdout.write(`${item.ok ? "✓" : "✗"} ${item.id}: ${item.detail}\n`);
    if (relay) process.stdout.write(`\n${relayWarning(relay, claudeSettingsPath(), claudeLoginHint())}\n`);
  }
  return checks.every(counts) ? 0 : 1;
}

interface ClaudeAuthStatus {
  readonly loggedIn: boolean;
  readonly authMethod?: string;
  readonly email?: string;
}

/** `claude auth status --json` of the claude CCodex runs (it exits 1 when not logged in, still printing the JSON). */
async function claudeAuthStatus(config: Config): Promise<ClaudeAuthStatus> {
  const { stdout } = await execute(config.claudeBinary, ["auth", "status", "--json"], { timeout: 15_000, windowsHide: true })
    .catch((error: { stdout?: string }) => ({ stdout: error.stdout ?? "{}" }));
  const status = JSON.parse(stdout || "{}") as { loggedIn?: boolean; email?: string; authMethod?: string };
  return { loggedIn: status.loggedIn === true, ...(status.authMethod ? { authMethod: status.authMethod } : {}), ...(status.email ? { email: status.email } : {}) };
}

/**
 * `ccodex auth status`: Claude's login as CCodex uses it, and whether it is an Anthropic (claude.ai) login that no
 * third-party endpoint overrides. JSON for scripts (install.ps1); exit 0 only for an Anthropic login.
 */
async function authStatus(config: Config): Promise<number> {
  const status = await claudeAuthStatus(config);
  const relayHost = configuredRelayHost();
  const anthropicLogin = status.loggedIn && status.authMethod === "claude.ai" && !relayHost;
  process.stdout.write(`${JSON.stringify({ ...status, ...(relayHost ? { relayHost } : {}), anthropicLogin, loginHint: claudeLoginHint() })}\n`);
  return anthropicLogin ? 0 : 1;
}

export async function runManagementCommand(args: readonly string[], config: () => Config): Promise<number | undefined> {
  switch (args[0]) {
    case "setup": return setup(args.slice(1));
    case "update": return update(args.slice(1));
    case "uninstall": return uninstall(args.slice(1));
    case "doctor": return doctor(config(), args.includes("--json"));
    case "auth":
      if (args[1] === "codex") return delegate(config().codex, ["login"]);
      if (args[1] === "claude") {
        // Windows: CCodex opens (and copies) the login link itself when Claude does not.
        return isWindows ? runClaudeLogin(config().claudeBinary, ["auth", "login"]) : delegate(config().claudeBinary, ["auth", "login"]);
      }
      if (args[1] === "status") return authStatus(config());
      throw new Error("Usage: ccodex auth codex|claude|status");
    default: return undefined;
  }
}

