import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { createConnection } from "node:net";
import { basename, join } from "node:path";
import WebSocket from "ws";
import type { Config } from "../config.js";
import type { Logger } from "../log.js";
import { isWindows, listWindowsProcesses, terminateProcessTree } from "../platform/process.js";
import { RpcFailure, type JsonObject } from "../protocol/codex.js";

/**
 * Where stock listens. Node on Windows cannot reach AF_UNIX sockets, so there stock serves loopback websocket
 * guarded by a capability token only this gateway knows (stock is given its SHA-256).
 */
export type StockEndpoint =
  | { readonly socketPath: string }
  | { readonly url: string; readonly token: string };

export interface StockProcess {
  readonly endpoint: StockEndpoint;
  stop(): Promise<void>;
}

function processTree(root: number): number[] {
  const output = spawnSync("ps", ["-eo", "pid=,ppid="], { encoding: "utf8" }).stdout;
  const children = new Map<number, number[]>();
  for (const line of output.trim().split("\n")) {
    const [pid, parent] = line.trim().split(/\s+/u).map(Number);
    children.set(parent!, [...children.get(parent!) ?? [], pid!]);
  }
  const tree = [root];
  for (let index = 0; index < tree.length; index += 1) tree.push(...children.get(tree[index]!) ?? []);
  return tree.reverse();
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The gateway's SIGTERM path; on Windows a signal to oneself would just terminate, so its handlers run directly. */
function terminateGateway(): void {
  if (isWindows) process.emit("SIGTERM", "SIGTERM");
  else process.kill(process.pid, "SIGTERM");
}

/** Windows: stock on an ephemeral loopback port; the port is read from its startup banner on stderr. */
const WINDOWS_LISTEN = "ws://127.0.0.1:0";

/**
 * Windows does not end a process's children with it: a stock whose gateway was killed alone (not as a tree) runs on,
 * unreachable (only that gateway knew its token). Ours are told by their listener and token flags; theirs is a gateway
 * gone (or a younger process that reused its pid).
 */
async function sweepOrphanedStock(config: Config, logger: Logger): Promise<void> {
  const found = await listWindowsProcesses({ name: basename(config.codex), withParents: true, commandLine: true });
  const byPid = new Map(found.map((info) => [info.pid, info]));
  for (const info of found) {
    const commandLine = info.commandLine ?? "";
    if (!commandLine.includes(`--listen ${WINDOWS_LISTEN}`) || !commandLine.includes("--ws-token-sha256")) continue;
    const parent = byPid.get(info.parentPid);
    if (parent && parent.pid !== info.pid && parent.createdMs <= info.createdMs) continue;
    logger.warn("stock.orphan.killed", { pid: info.pid });
    await terminateProcessTree(info.pid, { graceful: false });
  }
}

async function startWindowsStockProcess(config: Config, args: readonly string[], logger: Logger): Promise<StockProcess> {
  void sweepOrphanedStock(config, logger).catch((error: unknown) => logger.warn("stock.orphan.sweep-failed", { error: String(error) }));
  // As the POSIX path's run directory does: the state written next to it (models, catalog) needs it.
  mkdirSync(config.dataDir, { recursive: true, mode: 0o700 });
  const token = randomBytes(32).toString("hex");
  const child: ChildProcess = spawn(config.codex, [
    ...args,
    "--listen", WINDOWS_LISTEN,
    "--ws-auth", "capability-token",
    "--ws-token-sha256", createHash("sha256").update(token).digest("hex"),
  ], {
    env: { ...process.env, CODEX_CLI_PATH: undefined, CCODEX_SHIM_ACTIVE: undefined, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" },
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
  });
  let stopping = false;
  let banner = "";
  let url: string | undefined;
  child.stderr?.on("data", (data: Buffer) => {
    const output = data.toString("utf8");
    logger.debug("stock.stderr", { output: output.trimEnd() });
    if (url) return;
    banner += output;
    // `\D` waits for the whole port when the banner arrives split (or colored).
    const port = /ws:\/\/127\.0\.0\.1:([1-9]\d{0,4})\D/u.exec(banner)?.[1];
    if (port) url = `ws://127.0.0.1:${port}`;
  });
  child.once("error", (error) => logger.error("stock.spawn.error", { error: error.message }));
  child.once("exit", (code, signal) => {
    if (stopping) return;
    logger.error("stock.exited", { code, signal });
    terminateGateway();
  });
  const kill = () => child.pid ? terminateProcessTree(child.pid, { graceful: false }) : Promise.resolve();
  const deadline = Date.now() + 15_000;
  while (!url) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stopping = true;
      await kill();
      throw new Error(`Stock codex app-server did not start (${config.codex}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  logger.info("stock.started", { pid: child.pid, url, codex: config.codex });
  return {
    endpoint: { url, token },
    async stop() {
      stopping = true;
      // A console process without a window ignores taskkill's close request: force it.
      if (child.exitCode === null) await kill();
    },
  };
}

/** Spawns the installed `codex app-server` on a private unix socket. Its exit takes the gateway down. */
export async function startStockProcess(config: Config, args: readonly string[], logger: Logger): Promise<StockProcess> {
  if (isWindows) return startWindowsStockProcess(config, args, logger);
  const runRoot = join(config.dataDir, "run");
  // A gateway killed without stopping leaves its directory behind.
  for (const pid of existsSync(runRoot) ? readdirSync(runRoot) : []) {
    if (!alive(Number(pid))) rmSync(join(runRoot, pid), { recursive: true, force: true });
  }
  const runDir = join(runRoot, String(process.pid));
  const socketPath = join(runDir, "stock.sock");
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  rmSync(socketPath, { force: true });
  const child: ChildProcess = spawn(config.codex, [...args, "--listen", `unix://${socketPath}`], {
    env: { ...process.env, CODEX_CLI_PATH: undefined, CCODEX_SHIM_ACTIVE: undefined, CODEX_INTERNAL_APP_SERVER_REMOTE_CONTROL_DISABLED: "1" },
    stdio: ["ignore", "ignore", "pipe"],
  });
  let stopping = false;
  child.stderr?.on("data", (data: Buffer) => logger.debug("stock.stderr", { output: data.toString("utf8").trimEnd() }));
  child.once("error", (error) => logger.error("stock.spawn.error", { error: error.message }));
  child.once("exit", (code, signal) => {
    if (stopping) return;
    logger.error("stock.exited", { code, signal });
    terminateGateway();
  });
  const signal = (name: NodeJS.Signals) => {
    if (!child.pid) return;
    for (const pid of processTree(child.pid)) {
      try { process.kill(pid, name); } catch { /* already exited */ }
    }
  };
  const deadline = Date.now() + 15_000;
  while (!existsSync(socketPath)) {
    if (child.exitCode !== null || Date.now() > deadline) {
      stopping = true;
      signal("SIGKILL");
      throw new Error(`Stock codex app-server did not start (${config.codex}).`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  logger.info("stock.started", { pid: child.pid, socketPath, codex: config.codex });
  return {
    endpoint: { socketPath },
    async stop() {
      stopping = true;
      if (child.exitCode === null) {
        signal("SIGTERM");
        await Promise.race([
          new Promise((resolve) => child.once("exit", resolve)),
          new Promise((resolve) => setTimeout(resolve, 3_000)).then(() => signal("SIGKILL")),
        ]);
      }
      rmSync(runDir, { recursive: true, force: true });
    },
  };
}

export function openStockSocket(endpoint: StockEndpoint): WebSocket {
  if ("url" in endpoint) {
    return new WebSocket(endpoint.url, {
      headers: { Authorization: `Bearer ${endpoint.token}` },
      perMessageDeflate: false,
      maxPayload: 256 * 1024 * 1024,
    });
  }
  return new WebSocket("ws://codex-app-server/rpc", {
    createConnection: () => createConnection(endpoint.socketPath),
    perMessageDeflate: false,
    maxPayload: 256 * 1024 * 1024,
  });
}

interface Pending {
  readonly resolve: (value: any) => void;
  readonly reject: (error: Error) => void;
}

const OWN_ID = "\"ccodex-up:";

/**
 * One websocket to stock. Raw frames go to `onFrame` untouched; responses to requests made through
 * `request()` (string ids `ccodex-up:<n>`) are consumed here.
 */
export class StockClient {
  private readonly pending = new Map<string, Pending>();
  private readonly opened: Promise<void>;
  private nextId = 0;
  private closedError?: Error;
  public onFrame: (text: string) => void = () => undefined;
  public onClose: () => void = () => undefined;

  public constructor(public readonly socket: WebSocket) {
    this.opened = new Promise((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    this.opened.catch(() => undefined);
    socket.on("message", (data) => this.receive(data.toString()));
    socket.on("error", () => undefined);
    socket.once("close", () => {
      this.closedError = new Error("Stock app-server connection closed.");
      for (const pending of this.pending.values()) pending.reject(this.closedError);
      this.pending.clear();
      this.onClose();
    });
  }

  public static async connect(endpoint: StockEndpoint, clientName = "ccodex"): Promise<StockClient> {
    // Stock prints its websocket banner as it binds: a first connection may still be refused for a moment.
    const deadline = Date.now() + ("url" in endpoint ? 2_000 : 0);
    let client = new StockClient(openStockSocket(endpoint));
    for (;;) {
      try {
        await client.opened;
        break;
      } catch (error) {
        if (Date.now() >= deadline) throw error;
        await new Promise((resolve) => setTimeout(resolve, 100));
        client = new StockClient(openStockSocket(endpoint));
      }
    }
    await client.request("initialize", {
      clientInfo: { name: clientName, title: "CCodex", version: "0.5.0" },
      capabilities: { experimentalApi: true },
    });
    client.notify("initialized");
    return client;
  }

  public async send(text: string): Promise<void> {
    await this.opened;
    if (this.closedError) throw this.closedError;
    await new Promise<void>((resolve, reject) => this.socket.send(text, (error) => error ? reject(error) : resolve()));
  }

  public notify(method: string, params?: unknown): void {
    void this.send(JSON.stringify(params === undefined ? { method } : { method, params })).catch(() => undefined);
  }

  public request<T = any>(method: string, params?: unknown): Promise<T> {
    const id = `ccodex-up:${++this.nextId}`;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send(JSON.stringify({ id, method, params })).catch((error: Error) => {
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  public close(): void {
    this.socket.close();
  }

  private receive(text: string): void {
    if (text.includes(OWN_ID)) {
      const message = JSON.parse(text) as JsonObject;
      const pending = message.method === undefined && typeof message.id === "string" ? this.pending.get(message.id) : undefined;
      if (pending) {
        this.pending.delete(message.id);
        if (message.error) pending.reject(new RpcFailure(message.error.code ?? -32603, message.error.message, message.error.data));
        else pending.resolve(message.result);
        return;
      }
    }
    this.onFrame(text);
  }
}
