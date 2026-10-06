/** Every test's temp files go to one per-run directory, removed when the run ends. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const root = mkdtempSync(join(tmpdir(), "ccodex-vitest-"));
  process.env.TMPDIR = root;
  // os.tmpdir() reads TEMP/TMP on Windows and ignores TMPDIR.
  if (process.platform === "win32") {
    process.env.TEMP = root;
    process.env.TMP = root;
  }
  return () => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
