import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, userInfo } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parse } from "smol-toml";

export interface Config {
  /** The codex installed on the machine (PATH, skipping our shims), or `codex_binary`. */
  readonly codex: string;
  readonly claudeBinary: string;
  readonly claudeHome: string;
  readonly productHome: string;
  readonly dataDir: string;
  readonly publicSocket: string;
  readonly modelPrefix: string;
  readonly logLevel: "debug" | "info" | "warn" | "error";
  readonly rpcCapture: boolean;
  readonly rpcCaptureMaxBytes: number;
  /** Presence enables CCodex titles; absence keeps stock title behaviour. */
  readonly renamePrompt?: string;
  /** Model that writes titles; default: stock's fast one (…-luna / …-mini), else its default model. */
  readonly titleModel?: string;
  /** What a plain `codex …` (TUI, exec, login) runs; defaults to the installed codex. */
  readonly delegateCodex: string;
  /** Our formulas and plots instructions for Codex and Claude models in the app. */
  readonly improveModelsFormatting: boolean;
}

export const DEFAULT_RENAME_PROMPT = `Create a concise, vivid, memorable title for the task.
Start with exactly one rare, expressive, context-relevant emoji followed by one space.
Avoid generic decorative emoji when a more specific symbol fits.
Keep the complete title, including emoji, within 36 characters.
Return only the title.`;

export function defaultConfigToml(): string {
  return `# Remove or comment out rename_prompt to restore stock Codex title generation.
rename_prompt = """
${DEFAULT_RENAME_PROMPT}
"""
`;
}

const require = createRequire(import.meta.url);

const CLAUDE_PACKAGES: Readonly<Record<string, string>> = {
  "darwin-arm64": "@anthropic-ai/claude-agent-sdk-darwin-arm64",
  "darwin-x64": "@anthropic-ai/claude-agent-sdk-darwin-x64",
  "linux-arm64-gnu": "@anthropic-ai/claude-agent-sdk-linux-arm64",
  "linux-arm64-musl": "@anthropic-ai/claude-agent-sdk-linux-arm64-musl",
  "linux-x64-gnu": "@anthropic-ai/claude-agent-sdk-linux-x64",
  "linux-x64-musl": "@anthropic-ai/claude-agent-sdk-linux-x64-musl",
  "win32-arm64": "@anthropic-ai/claude-agent-sdk-win32-arm64",
  "win32-x64": "@anthropic-ai/claude-agent-sdk-win32-x64",
};

let platformKey: string | undefined;

/** Read once: the process report that tells glibc from musl takes tens of milliseconds. */
export function runtimePlatformKey(): string {
  if (platformKey) return platformKey;
  if (process.platform !== "linux") return platformKey = `${process.platform}-${process.arch}`;
  const report = process.report?.getReport() as { header?: { glibcVersionRuntime?: string } } | undefined;
  return platformKey = `linux-${process.arch}-${report?.header?.glibcVersionRuntime ? "gnu" : "musl"}`;
}

export function bundledClaudeExecutable(): string {
  const packageName = CLAUDE_PACKAGES[runtimePlatformKey()];
  if (!packageName) return "claude";
  try {
    const binary = join(dirname(require.resolve(`${packageName}/package.json`)), process.platform === "win32" ? "claude.exe" : "claude");
    if (existsSync(binary)) return binary;
  } catch {
    // Fall back to a separately installed Claude CLI.
  }
  return "claude";
}

export const expandHome = (value: string) =>
  value === "~" ? homedir()
    : value.startsWith("~/") || (process.platform === "win32" && value.startsWith("~\\")) ? join(homedir(), value.slice(2)) : value;

export function productHome(): string {
  return expandHome(process.env.CCODEX_HOME ?? join(homedir(), ".ccodex"));
}

export function claudeHome(): string {
  return process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

export function codexHome(): string {
  return process.env.CODEX_HOME ?? join(homedir(), ".codex");
}

function inside(path: string, root: string): boolean {
  const child = relative(existsSync(root) ? realpathSync(root) : resolve(root), realpathSync(path));
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

/** Where Codex's installer (and Desktop over SSH) puts `codex`; `ccodex setup` links it to CCodex. */
export function remoteCodexPath(): string {
  return join(resolve(expandHome(process.env.CODEX_INSTALL_DIR ?? join(homedir(), ".local", "bin"))), "codex");
}

/** The `codex` that `ccodex setup` moved away from `remoteCodexPath()`. */
export function displacedCodexPath(home = productHome()): string {
  return join(home, "backups", "remote-codex");
}

/** CCodex itself: its shims, managed installs, this entrypoint. */
export function isCcodex(path: string, home = productHome()): boolean {
  const real = realpathSync(path);
  const own = process.argv[1] && existsSync(process.argv[1]) ? realpathSync(process.argv[1]) : undefined;
  return inside(path, join(home, "bin")) || inside(path, join(home, "versions")) || real === own || real.split(sep).join("/").includes("/@gkorepanov/ccodex/");
}

/** Windows names a `codex` on PATH may have (PATHEXT); elsewhere just `codex`. */
function codexNames(): string[] {
  if (process.platform !== "win32") return ["codex"];
  return (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean).map((extension) => `codex${extension.toLowerCase()}`);
}

/**
 * Windows: npm's `codex.cmd` launcher cannot be spawned without a shell, so use the native `codex.exe` it runs
 * (@openai/codex's platform package). Anything else is returned unchanged.
 */
export function nativeCodexExecutable(path: string): string {
  if (process.platform !== "win32" || ![".cmd", ".bat", ".ps1"].includes(extname(path).toLowerCase())) return path;
  const triple = process.arch === "arm64" ? "aarch64-pc-windows-msvc" : "x86_64-pc-windows-msvc";
  // npm's global prefix keeps packages in ./node_modules; a project's .bin sits inside node_modules.
  for (const root of [join(dirname(path), "node_modules"), dirname(dirname(path))]) {
    try {
      const launcher = createRequire(join(root, "@openai", "codex", "package.json"));
      const binary = join(dirname(launcher.resolve(`@openai/codex-win32-${process.arch}/package.json`)), "vendor", triple, "bin", "codex.exe");
      if (existsSync(binary)) return binary;
    } catch {
      // Not npm's launcher here.
    }
  }
  return path;
}

/** First `codex` on PATH that is not CCodex; at `remoteCodexPath()` that is the codex CCodex displaced there. */
export function findInstalledCodex(home = productHome()): string | undefined {
  const remote = remoteCodexPath();
  const displaced = displacedCodexPath(home);
  for (const candidate of (process.env.PATH ?? "").split(delimiter)
    .flatMap((directory) => codexNames().map((name) => resolve(directory || ".", name)))) {
    if (!existsSync(candidate)) continue;
    if (!isCcodex(candidate, home)) return candidate;
    if (candidate === remote && existsSync(displaced) && !isCcodex(displaced, home)) return displaced;
  }
  return undefined;
}

/** Windows: a per-user (and per-CODEX_HOME) named pipe stands in for the control socket Node cannot serve there. */
export function defaultPublicSocket(): string {
  if (process.platform !== "win32") return join(codexHome(), "app-server-control", "app-server-control.sock");
  const user = userInfo().username.replace(/[^A-Za-z0-9._-]/gu, "_");
  const home = createHash("sha256").update(resolve(codexHome()).toLowerCase()).digest("hex").slice(0, 12);
  return `\\\\.\\pipe\\ccodex-${user}-${home}-app-server-control`;
}

const PIPE_PREFIX = /^[\\/]{2}[.?][\\/]pipe[\\/]/iu;

/** A Windows named pipe (`\\.\pipe\name`): served and reached like a socket, but nothing on disk. */
export const isNamedPipe = (path: string) => process.platform === "win32" && PIPE_PREFIX.test(path);

/** Where files that belong to an endpoint (its locks, owner record) live: beside a socket; for a pipe, in CODEX_HOME. */
export function endpointFile(socketPath: string, suffix: string): string {
  if (!isNamedPipe(socketPath)) return `${socketPath}${suffix}`;
  return join(codexHome(), "app-server-control", `${socketPath.replace(PIPE_PREFIX, "").replace(/[\\/:*?"<>|]/gu, "_")}${suffix}`);
}

export function loadConfig(): Config {
  const home = productHome();
  const configPath = expandHome(process.env.CCODEX_CONFIG ?? join(home, "config.toml"));
  const file = existsSync(configPath) ? parse(readFileSync(configPath, "utf8")) as Record<string, any> : {};
  const configuredCodex = process.env.CCODEX_CODEX ?? file.codex_binary as string | undefined;
  const found = configuredCodex ? resolve(expandHome(configuredCodex)) : findInstalledCodex(home);
  const codex = found && nativeCodexExecutable(found);
  if (!codex) throw new Error("No `codex` found on PATH. Install it with `npm i -g @openai/codex` or set codex_binary in ~/.ccodex/config.toml.");
  const renamePrompt = typeof file.rename_prompt === "string" && file.rename_prompt.trim() ? file.rename_prompt.trim() : undefined;
  return {
    codex,
    claudeBinary: process.env.CCODEX_CLAUDE_BINARY ?? file.claude_binary ?? bundledClaudeExecutable(),
    claudeHome: claudeHome(),
    productHome: home,
    dataDir: expandHome(process.env.CCODEX_DATA_DIR ?? file.data_dir ?? join(home, "state")),
    publicSocket: expandHome(process.env.CCODEX_SOCKET ?? file.public_socket ?? defaultPublicSocket()),
    modelPrefix: file.model_prefix ?? "claude:",
    logLevel: process.env.CCODEX_LOG_LEVEL as Config["logLevel"] ?? file.log_level ?? "info",
    rpcCapture: process.env.CCODEX_RPC_CAPTURE ? process.env.CCODEX_RPC_CAPTURE === "1" : file.rpc_capture ?? false,
    rpcCaptureMaxBytes: file.rpc_capture_max_bytes ?? 1_073_741_824,
    ...(renamePrompt ? { renamePrompt } : {}),
    ...(file.title_model ? { titleModel: file.title_model as string } : {}),
    delegateCodex: nativeCodexExecutable(expandHome(process.env.CCODEX_DELEGATE_CODEX ?? file.delegate_codex ?? codex)),
    improveModelsFormatting: file.improve_models_formatting_for_codex_app ?? true,
  };
}
