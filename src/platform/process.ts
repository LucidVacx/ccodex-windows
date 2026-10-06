import { execFile, spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { win32 } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POLL_MS = 50;

export const isWindows = process.platform === "win32";

// By full path: Windows looks for a bare name in the working directory first (a user's repository, for the MCP server).
const SYSTEM32 = win32.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const TASKKILL = win32.join(SYSTEM32, "taskkill.exe");
const POWERSHELL = win32.join(SYSTEM32, "WindowsPowerShell", "v1.0", "powershell.exe");
const POWERSHELL_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function taskkill(pid: number, force: boolean): Promise<void> {
  // Exit code 128 = not found: an already-exited tree is the goal state.
  await execFileAsync(TASKKILL, ["/PID", String(pid), "/T", ...(force ? ["/F"] : [])], { windowsHide: true })
    .catch(() => undefined);
}

/**
 * POSIX: SIGTERM the process group led by `pid`, SIGKILL after `timeoutMs`.
 * Windows: `taskkill /T` (a close request) then `/T /F`. Console processes
 * without a window ignore the plain request, so it is mostly a courtesy.
 */
export async function terminateProcessTree(
  pid: number,
  opts: { graceful?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) return;
  const graceful = opts.graceful ?? true;
  const timeoutMs = opts.timeoutMs ?? 5_000;
  const alive = isWindows ? () => isProcessAlive(pid) : () => groupAlive(pid);
  if (!alive()) return;
  if (graceful) {
    if (isWindows) await taskkill(pid, false);
    else signalGroup(pid, "SIGTERM");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (!alive()) return;
      await new Promise((resolve) => setTimeout(resolve, POLL_MS));
    }
  }
  if (isWindows) await taskkill(pid, true);
  else signalGroup(pid, "SIGKILL");
}

/** Synchronous forced tree kill, for exit handlers and sync cleanup paths. */
export function killProcessTreeSync(pid: number): void {
  if (!Number.isInteger(pid) || pid <= 0) return;
  if (isWindows) {
    spawnSync(TASKKILL, ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
  } else {
    signalGroup(pid, "SIGKILL");
  }
}

/** Runs a Windows PowerShell script (hidden); its trimmed stdout, or undefined when it fails. */
export function powershell(script: string, env?: NodeJS.ProcessEnv): string | undefined {
  const result = spawnSync(POWERSHELL, [...POWERSHELL_ARGS, script],
    { encoding: "utf8", windowsHide: true, timeout: 15_000, ...(env ? { env: { ...process.env, ...env } } : {}) });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

/** `powershell()` without blocking the event loop, for a running gateway. */
export async function powershellAsync(script: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync(POWERSHELL, [...POWERSHELL_ARGS, script],
      { encoding: "utf8", windowsHide: true, timeout: 15_000, maxBuffer: 64 * 1024 * 1024 });
    return stdout.trim();
  } catch {
    return undefined;
  }
}

const PIPE_PREFIX = /^[\\/]{2}[.?][\\/]pipe[\\/]/iu;

/** Whether a named pipe is being served, from the pipe listing (no connection to its server). */
export function windowsPipeExists(pipePath: string): boolean {
  const name = pipePath.replace(PIPE_PREFIX, "").toLowerCase();
  try {
    return readdirSync("\\\\.\\pipe\\").some((entry) => entry.toLowerCase() === name);
  } catch {
    return false;
  }
}

const PIPE_SERVER_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -Namespace CCodex -Name Pipe -MemberDefinition '[DllImport("kernel32.dll", SetLastError = true)] public static extern bool GetNamedPipeServerProcessId(Microsoft.Win32.SafeHandles.SafePipeHandle pipe, out uint pid);'
$client = New-Object System.IO.Pipes.NamedPipeClientStream('.', $env:CCODEX_PIPE_NAME, [System.IO.Pipes.PipeDirection]::InOut)
$client.Connect(2000)
$id = [uint32]0
$ok = [CCodex.Pipe]::GetNamedPipeServerProcessId($client.SafePipeHandle, [ref]$id)
$client.Dispose()
if (-not $ok) { exit 3 }
$id`;

/**
 * The pid serving a named pipe (GetNamedPipeServerProcessId), as `lsof` names a Unix socket's. It connects once and
 * hangs up, which the server sees as a client that left. Undefined when nobody serves it or it cannot be asked.
 */
export function windowsPipeServerPid(pipePath: string): number | undefined {
  const out = powershell(PIPE_SERVER_SCRIPT, { CCODEX_PIPE_NAME: pipePath.replace(PIPE_PREFIX, "") });
  return out && /^\d+$/u.test(out) ? Number(out) : undefined;
}

/** Locale-free Windows process creation time (UTC .NET ticks), or undefined if gone/inaccessible. */
export function windowsProcessStartTime(pid: number): string | undefined {
  if (!isProcessAlive(pid)) return undefined;
  const ticks = powershell(`(Get-Process -Id ${pid} -ErrorAction Stop).StartTime.ToUniversalTime().Ticks`);
  return ticks && /^\d+$/u.test(ticks) ? `win32:${ticks}` : undefined;
}

export interface WindowsProcessInfo {
  readonly pid: number;
  /** Windows keeps a parent's pid after it exits (and may reuse it): valid only if the parent is not younger. */
  readonly parentPid: number;
  /** Creation time, ms since 1601 (UTC); 0 when Windows reports none (the Idle process). */
  readonly createdMs: number;
  /** User + kernel CPU seconds. */
  readonly cpu: number;
  /** Image name, e.g. `claude.exe`. */
  readonly name: string;
  /** Only when asked for (`commandLine: true`); empty when unreadable. */
  readonly commandLine?: string;
}

/**
 * One snapshot of the Win32 process table, or of the processes `pids` or the image `name` names (with `withParents`,
 * their parents too): one PowerShell run whatever is asked. Throws when unavailable.
 */
export async function listWindowsProcesses(
  options: { pids?: readonly number[]; name?: string; withParents?: boolean; commandLine?: boolean } = {},
): Promise<WindowsProcessInfo[]> {
  const filter = (ids: string) => ` -Filter ("ProcessId=" + (${ids} -join " OR ProcessId="))`;
  const pids = options.pids?.map((pid) => Math.trunc(pid)).join(",");
  if (options.name !== undefined && !/^[\w.-]+$/u.test(options.name)) throw new Error(`invalid image name '${options.name}'`);
  const select = "Select-Object ProcessId,ParentProcessId,Name,"
    + "@{n='Created';e={if ($_.CreationDate) {[long]($_.CreationDate.ToFileTimeUtc()/10000)} else {0}}},"
    + "@{n='Cpu';e={$_.KernelModeTime+$_.UserModeTime}}"
    + (options.commandLine ? ",CommandLine" : "");
  const query = (options.name !== undefined ? `$p = @(Get-CimInstance Win32_Process -Filter "Name='${options.name}'")`
    : pids === undefined ? "$p = @(Get-CimInstance Win32_Process)"
    : pids === "" ? "$p = @()"
    : `$p = @(Get-CimInstance Win32_Process${filter(`@(${pids})`)})`)
    + (options.withParents ? `; $q = @($p | ForEach-Object { $_.ParentProcessId } | Sort-Object -Unique); if ($q.Count) { $p += @(Get-CimInstance Win32_Process${filter("$q")}) }` : "");
  const json = await powershellAsync(`$ErrorActionPreference = 'Stop'; ${query}; @($p | ${select}) | ConvertTo-Json -Compress`);
  if (json === undefined) throw new Error("failed to list Windows processes");
  if (!json) return [];
  const parsed = JSON.parse(json) as unknown;
  const rows = (Array.isArray(parsed) ? parsed : [parsed]) as Record<string, unknown>[];
  const seen = new Set<number>();
  return rows.flatMap((row) => Number.isInteger(row.ProcessId) && Number.isInteger(row.ParentProcessId) && !seen.has(row.ProcessId as number)
    && seen.add(row.ProcessId as number)
    ? [{
      pid: row.ProcessId as number,
      parentPid: row.ParentProcessId as number,
      createdMs: Number(row.Created) || 0,
      cpu: (Number(row.Cpu) || 0) / 1e7,
      name: typeof row.Name === "string" ? row.Name : "",
      ...(options.commandLine ? { commandLine: typeof row.CommandLine === "string" ? row.CommandLine : "" } : {}),
    }]
    : []);
}
