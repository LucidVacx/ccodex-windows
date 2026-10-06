// `npm run build:relay` / `npm test`'s relay step: the Rust relay is not ported to Windows yet, so there it is skipped
// with a notice; elsewhere this runs exactly what the scripts ran before (build-relay.sh, cargo test).
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const task = process.argv[2];
const commands = {
  build: [join(root, "scripts", "build-relay.sh"), []],
  test: ["cargo", ["test", "--manifest-path", join(root, "relay", "Cargo.toml"), "--quiet"]],
};
if (!(task in commands)) {
  console.error(`usage: relay-task.mjs ${Object.keys(commands).join("|")}`);
  process.exit(2);
}
if (process.platform === "win32") {
  console.error(`Skipping the relay ${task}: the CCodex relay is not supported on Windows yet.`);
  process.exit(0);
}
const [command, args] = commands[task];
const result = spawnSync(command, args, { stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
