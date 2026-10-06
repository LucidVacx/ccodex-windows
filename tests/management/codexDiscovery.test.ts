import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findInstalledCodex } from "../../src/config.js";

const env = { ...process.env };
let root: string;
/** Windows finds `codex` on PATH by its PATHEXT names. */
const CODEX = process.platform === "win32" ? "codex.cmd" : "codex";
const executable = (path: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, "#!/bin/sh\n"); chmodSync(path, 0o755); return path; };
/** These links are file symlinks; Windows makes them only with Developer Mode on or as administrator. */
let symlinks = true;
const link = (target: string, path: string) => {
  try {
    symlinkSync(target, path, "file");
  } catch (error) {
    if (process.platform !== "win32" || (error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    symlinks = false;
  }
};

describe("the stock codex CCodex runs", () => {
  beforeEach((context) => {
    root = mkdtempSync(join(tmpdir(), "ccodex-discovery-"));
    process.env.CCODEX_HOME = join(root, "ccodex");
    process.env.CODEX_INSTALL_DIR = join(root, "local-bin");
    executable(join(root, "ccodex", "bin", CODEX));
    mkdirSync(join(root, "local-bin"));
    link(join(root, "ccodex", "bin", CODEX), join(root, "local-bin", CODEX));
    if (!symlinks) context.skip("file symlinks need Windows Developer Mode or an elevated shell");
  });
  afterEach(() => { process.env = { ...env }; });

  it("is the first codex on PATH that is not CCodex", () => {
    const npm = executable(join(root, "npm", CODEX));
    process.env.PATH = [join(root, "ccodex", "bin"), join(root, "local-bin"), join(root, "npm")].join(delimiter);
    expect(findInstalledCodex()).toBe(npm);
  });

  it("at ~/.local/bin, where CCodex took the installer's link, is the codex the installer put there", () => {
    const standalone = executable(join(root, "codex-home", "packages", "standalone", "current", "bin", CODEX));
    mkdirSync(join(root, "ccodex", "backups"));
    symlinkSync(standalone, join(root, "ccodex", "backups", "remote-codex"), "file");
    executable(join(root, "npm", CODEX));
    process.env.PATH = [join(root, "local-bin"), join(root, "ccodex", "bin"), join(root, "npm")].join(delimiter);
    expect(findInstalledCodex()).toBe(join(root, "ccodex", "backups", "remote-codex"));
  });
});
