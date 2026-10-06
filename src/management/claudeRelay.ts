/**
 * Claude Code routed to a third-party endpoint: an `env.ANTHROPIC_BASE_URL` in Claude's settings.json that is not
 * Anthropic's. CCodex only warns (it never edits that file) and shows the host alone: the same env block usually
 * carries a token.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeHome } from "../config.js";

/** The third-party host `settings` (parsed settings.json) sends Claude Code to; undefined for Anthropic or unset. */
export function relayHost(settings: unknown): string | undefined {
  const env = settings !== null && typeof settings === "object" ? (settings as { env?: unknown }).env : undefined;
  const value = env !== null && typeof env === "object" ? (env as Record<string, unknown>).ANTHROPIC_BASE_URL : undefined;
  if (typeof value !== "string" || !value.trim()) return undefined;
  let host: string;
  try {
    host = new URL(value.trim()).hostname.toLowerCase();
  } catch {
    return "an unrecognised address";
  }
  return host === "anthropic.com" || host.endsWith(".anthropic.com") ? undefined : host || "an unrecognised address";
}

export function claudeSettingsPath(): string {
  return join(claudeHome(), "settings.json");
}

/** The relay host Claude's own settings.json names, if any (unreadable settings name none). */
export function configuredRelayHost(path = claudeSettingsPath()): string | undefined {
  try {
    return existsSync(path) ? relayHost(JSON.parse(readFileSync(path, "utf8"))) : undefined;
  } catch {
    return undefined;
  }
}

/** What to tell the user about a relay; `login` is how to log in to Claude here. */
export function relayWarning(host: string, path: string, login: string): string {
  return [
    `Warning: Claude Code is configured to use a third-party endpoint (${host}) through ANTHROPIC_BASE_URL in the "env" block of ${path}.`,
    "  Claude chats then go through that service, not Anthropic: models may be limited, and it is not an Anthropic (claude.ai) login.",
    "  Using Claude through third-party services may not be covered by Anthropic's terms: https://www.anthropic.com/legal/consumer-terms",
    `  To use your Anthropic account instead: back up ${path}, remove its "env" block (CCodex never edits it for you), then log in: ${login}`,
  ].join("\n");
}
