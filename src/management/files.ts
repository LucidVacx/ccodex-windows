import { chmodSync, mkdirSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { isWindows } from "../platform/process.js";

export function atomicWrite(path: string, content: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp-${process.pid}`;
  writeFileSync(temporary, content, { mode });
  chmodSync(temporary, mode);
  renameSync(temporary, path);
}

export function atomicSymlink(target: string, path: string): void {
  const temporary = `${path}.tmp-${process.pid}`;
  rmSync(temporary, { force: true });
  if (!isWindows) {
    symlinkSync(target, temporary);
    renameSync(temporary, path);
    return;
  }
  // Windows: a directory junction needs no privilege (file symlinks do). A link cannot be renamed over another, so
  // the old one goes first (rmSync removes a junction, not its target): briefly, the path is missing.
  if (!statSync(resolve(dirname(path), target), { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`cannot link ${path} to ${target} on Windows: only directory links (junctions) are supported`);
  }
  symlinkSync(target, temporary, "junction");
  rmSync(path, { force: true });
  renameSync(temporary, path);
}
