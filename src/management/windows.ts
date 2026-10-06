/**
 * Windows counterparts of the POSIX setup's `#!/bin/sh` shims and shell rc PATH blocks: `codex.exe`/`ccodex.exe`
 * launchers (launcher/, a tiny Rust exe) with their sidecar, and the user environment (HKCU\Environment):
 * `CODEX_CLI_PATH` (the Codex app runs that codex) and `~/.ccodex/bin` first on the user PATH.
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, readdirSync, readFileSync, renameSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { atomicWrite } from "./files.js";

export const LAUNCHER_SIDECAR = "ccodex-launcher.cfg";
const LAUNCHERS = ["codex.exe", "ccodex.exe"] as const;

type ValueKind = "String" | "ExpandString";
type UserValue = { readonly value: string; readonly kind: ValueKind } | null;
interface UserEnvironment {
  readonly Path: UserValue;
  readonly CODEX_CLI_PATH: UserValue;
}

/** What setup changed in the user environment, kept in the install manifest so uninstall can undo exactly that. */
export interface WindowsEnvironment {
  readonly cliPath: string;
  readonly binEntry: string;
  /** CODEX_CLI_PATH before CCodex first set it (null: unset). */
  readonly previousCodexCliPath: UserValue;
  readonly pathEntryAdded: boolean;
}

const sha256 = (content: Buffer | string) => createHash("sha256").update(content).digest("hex");

/** The launcher this package ships (built by scripts/install.ps1), or CCODEX_LAUNCHER_EXE. */
export function launcherSource(packageRoot: string): string {
  const path = process.env.CCODEX_LAUNCHER_EXE ?? join(packageRoot, "launcher", "bin", `win32-${process.arch}`, "ccodex-launcher.exe");
  if (!existsSync(path)) throw new Error(`CCodex launcher not found at ${path}: build it with scripts/install.ps1 (cargo build --release in launcher/).`);
  return path;
}

/** A running exe cannot be overwritten or deleted, only renamed: the Codex app may be running codex.exe right now. */
function replaceExecutable(source: string, target: string, content: Buffer): void {
  if (existsSync(target) && sha256(readFileSync(target)) === sha256(content)) return;
  try {
    copyFileSync(source, target);
  } catch (error) {
    if (!["EBUSY", "EPERM", "EACCES"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
    renameSync(target, `${target}.old-${process.pid}-${Date.now()}`);
    copyFileSync(source, target);
  }
}

/** Writes the launchers and their sidecar into `bin`; the hashes of what it wrote, by file name. */
export function installLaunchers(bin: string, packageRoot: string, home: string, npmRoot: string | undefined): Record<string, string> {
  for (const name of readdirSync(bin)) {
    // Launchers renamed aside while they ran (see replaceExecutable).
    if (!/\.exe\.old-\d+-\d+$/u.test(name)) continue;
    try { rmSync(join(bin, name), { force: true }); } catch { /* still running: next setup */ }
  }
  const source = launcherSource(packageRoot);
  const content = readFileSync(source);
  const hashes: Record<string, string> = {};
  for (const name of LAUNCHERS) {
    replaceExecutable(source, join(bin, name), content);
    hashes[name] = sha256(content);
  }
  const sidecar = `node=${process.execPath}\nhome=${home}\n${npmRoot ? `npm_root=${npmRoot}\n` : ""}`;
  atomicWrite(join(bin, LAUNCHER_SIDECAR), sidecar, 0o600);
  hashes[LAUNCHER_SIDECAR] = sha256(sidecar);
  return hashes;
}

/** Windows PowerShell by absolute path (a PATH entry could shadow it), hidden; its stdout, or undefined on failure. */
function powershell(script: string, env?: NodeJS.ProcessEnv): string | undefined {
  const exe = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(exe, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script], {
    encoding: "utf8", windowsHide: true, timeout: 60_000, env: { ...process.env, ...env },
  });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

const READ_SCRIPT = `$key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
$out = @{}
foreach ($name in 'Path', 'CODEX_CLI_PATH') {
  $value = if ($key) { $key.GetValue($name, $null, 'DoNotExpandEnvironmentNames') } else { $null }
  $out[$name] = if ($null -eq $value) { $null } else { @{ value = [string]$value; kind = $key.GetValueKind($name).ToString() } }
}
$out | ConvertTo-Json -Compress`;

const WRITE_SCRIPT = `$ErrorActionPreference = 'Stop'
$changes = $env:CCODEX_ENV_CHANGES | ConvertFrom-Json
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
foreach ($change in $changes.PSObject.Properties) {
  if ($null -eq $change.Value) { $key.DeleteValue($change.Name, $false) }
  else { $key.SetValue($change.Name, [string]$change.Value.value, [Microsoft.Win32.RegistryValueKind]$change.Value.kind) }
}
$key.Close()
Add-Type -Namespace CCodex -Name Environment -MemberDefinition '[DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result);'
$result = [UIntPtr]::Zero
[void][CCodex.Environment]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)
'ok'`;

/**
 * HKCU\Environment, read without expanding (PATH is usually REG_EXPAND_SZ with %VARS%, which must survive) and written
 * with its kind kept, then WM_SETTINGCHANGE so new processes see it. CCODEX_USER_ENV_FILE (tests) puts a JSON file in
 * place of the registry.
 */
function readUserEnvironment(): UserEnvironment {
  const file = process.env.CCODEX_USER_ENV_FILE;
  const json = file ? existsSync(file) ? readFileSync(file, "utf8") : "{}" : powershell(READ_SCRIPT);
  if (json === undefined) throw new Error("failed to read the user environment (HKCU\\Environment)");
  const value = JSON.parse(json) as Partial<UserEnvironment>;
  return { Path: value.Path ?? null, CODEX_CLI_PATH: value.CODEX_CLI_PATH ?? null };
}

function writeUserEnvironment(changes: Partial<UserEnvironment>): void {
  if (Object.keys(changes).length === 0) return;
  const file = process.env.CCODEX_USER_ENV_FILE;
  if (file) {
    atomicWrite(file, `${JSON.stringify({ ...readUserEnvironment(), ...changes }, null, 2)}\n`, 0o600);
    return;
  }
  if (powershell(WRITE_SCRIPT, { CCODEX_ENV_CHANGES: JSON.stringify(changes) }) !== "ok") {
    throw new Error("failed to write the user environment (HKCU\\Environment)");
  }
}

const sameEntry = (left: string, right: string) => left.replace(/[\\/]+$/u, "").toLowerCase() === right.replace(/[\\/]+$/u, "").toLowerCase();

/** CODEX_CLI_PATH → bin\codex.exe and bin first on the user PATH; idempotent, keeping the first install's record. */
export function applyWindowsEnvironment(bin: string, previous: WindowsEnvironment | undefined): WindowsEnvironment {
  const current = readUserEnvironment();
  const cliPath = join(bin, "codex.exe");
  const changes: { -readonly [K in keyof UserEnvironment]?: UserValue } = {};
  if (current.CODEX_CLI_PATH?.value !== cliPath) changes.CODEX_CLI_PATH = { value: cliPath, kind: "String" };
  const entries = current.Path?.value.split(";").filter(Boolean) ?? [];
  const added = !entries.some((entry) => sameEntry(entry, bin));
  if (added) changes.Path = { value: [bin, ...entries].join(";"), kind: current.Path?.kind ?? "ExpandString" };
  writeUserEnvironment(changes);
  return {
    cliPath,
    binEntry: bin,
    previousCodexCliPath: previous
      ? previous.previousCodexCliPath
      : current.CODEX_CLI_PATH?.value === cliPath ? null : current.CODEX_CLI_PATH,
    pathEntryAdded: added || (previous?.pathEntryAdded ?? false),
  };
}

/** Undoes applyWindowsEnvironment, leaving anything the user changed since alone. */
export function restoreWindowsEnvironment(record: WindowsEnvironment): void {
  const current = readUserEnvironment();
  const changes: { -readonly [K in keyof UserEnvironment]?: UserValue } = {};
  if (current.CODEX_CLI_PATH?.value === record.cliPath) changes.CODEX_CLI_PATH = record.previousCodexCliPath;
  if (record.pathEntryAdded && current.Path) {
    const entries = current.Path.value.split(";").filter(Boolean);
    const kept = entries.filter((entry) => !sameEntry(entry, record.binEntry));
    if (kept.length !== entries.length) changes.Path = kept.length ? { value: kept.join(";"), kind: current.Path.kind } : null;
  }
  writeUserEnvironment(changes);
}

/** A copy of a user file setup is about to change, beside it (once per file and setup run). */
export function backupFile(path: string): void {
  if (existsSync(path)) copyFileSync(path, `${path}.ccodex-backup-${new Date().toISOString().replace(/[:.]/gu, "-")}`);
}

/** Whether `dir` is on this process's PATH (a terminal opened before setup keeps its old PATH). */
export function onProcessPath(dir: string): boolean {
  return (process.env.PATH ?? "").split(";").some((entry) => entry && sameEntry(entry, dir));
}

/** How to run `<name> <args>` from a terminal: by name when `bin` is on PATH here, else by full path. */
export function commandHint(bin: string, name: "ccodex" | "codex", args: string): string {
  return onProcessPath(bin) ? `${name} ${args}` : `"${join(bin, `${name}.exe`)}" ${args}`;
}

export const LOGIN_CMD = "Log in to Claude.cmd";
export const LOGIN_SHORTCUT_NAME = "CCodex - Log in to Claude";

/** The Start menu entry and the double-clickable script behind it, as the manifest records them. */
export interface WindowsLogin {
  readonly cmd: string;
  readonly shortcut: string;
}

/** How to log in to Claude without typing a long command: the Start menu entry first, then the command. */
export function loginHint(bin: string): string {
  return `Start menu → ${LOGIN_SHORTCUT_NAME}, or run: ${commandHint(bin, "ccodex", "auth claude")}`;
}

const LOGIN_SCRIPT = [
  "@echo off",
  `title ${LOGIN_SHORTCUT_NAME}`,
  "\"%~dp0ccodex.exe\" auth claude",
  "if errorlevel 1 (",
  "  echo.",
  "  echo Claude login did not finish ^(exit code %errorlevel%^). Close this window and open it again to retry.",
  ") else (",
  "  echo.",
  "  echo You are logged in to Claude. Close this window, then use Claude models in the Codex app.",
  ")",
  "echo.",
  "pause",
  "",
].join("\r\n");

const SHORTCUT_SCRIPT = `$ErrorActionPreference = 'Stop'
New-Item -ItemType Directory -Force (Split-Path -Parent $env:CCODEX_SHORTCUT) | Out-Null
$link = (New-Object -ComObject WScript.Shell).CreateShortcut($env:CCODEX_SHORTCUT)
$link.TargetPath = $env:CCODEX_SHORTCUT_TARGET
$link.WorkingDirectory = Split-Path -Parent $env:CCODEX_SHORTCUT_TARGET
$link.Description = 'Log in to Claude for Claude models in the Codex app (CCodex)'
$link.Save()
'ok'`;

function startMenuShortcut(): string {
  const appData = process.env.APPDATA ?? join(process.env.USERPROFILE ?? "", "AppData", "Roaming");
  return join(appData, "Microsoft", "Windows", "Start Menu", "Programs", "CCodex", `${LOGIN_SHORTCUT_NAME}.lnk`);
}

/** `bin\Log in to Claude.cmd` and its Start menu shortcut; the script's hash joins the launchers' for uninstall. */
export function installLoginShortcut(bin: string): { login: WindowsLogin; hash: string } {
  const cmd = join(bin, LOGIN_CMD);
  atomicWrite(cmd, LOGIN_SCRIPT, 0o600);
  const shortcut = startMenuShortcut();
  if (powershell(SHORTCUT_SCRIPT, { CCODEX_SHORTCUT: shortcut, CCODEX_SHORTCUT_TARGET: cmd }) !== "ok") {
    process.stderr.write(`CCodex setup warning: could not create the Start menu entry ${shortcut}; double-click ${cmd} instead.\n`);
  }
  return { login: { cmd, shortcut }, hash: sha256(LOGIN_SCRIPT) };
}

export function removeLoginShortcut(login: WindowsLogin): void {
  rmSync(login.shortcut, { force: true });
  try { rmdirSync(dirname(login.shortcut)); } catch { /* not empty, or gone */ }
  rmSync(login.cmd, { force: true });
}

/** Leftovers of interrupted setups (`<version>.installing-<pid>`, `<version>.old-<pid>`) whose setup is gone. */
export function removeStaleInstalls(versions: string, alive: (pid: number) => boolean): void {
  for (const name of readdirSync(versions)) {
    const pid = /\.(?:installing|old)-(\d+)$/u.exec(name)?.[1];
    if (!pid || Number(pid) === process.pid || alive(Number(pid))) continue;
    try {
      rmSync(join(versions, name), { recursive: true, force: true });
      process.stdout.write(`Removed ${name}, left by an earlier setup that did not finish.\n`);
    } catch { /* in use: the next setup retries */ }
  }
}
