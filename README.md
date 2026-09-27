<div align="center">

# Claude Code'x

**Claude models inside the official Codex App.**

*Claude Code'x — or just **CCodex** — lets the Codex desktop app, the ChatGPT mobile app
and the Codex CLI run Claude models next to GPT.*

</div>

```sh
curl -fsSL https://github.com/gkorepanov/ccodex/releases/latest/download/install.sh | sh
```

<p align="center">
  <img src="docs/screenshots/mobile-claude-model-picker.png" width="30%" alt="Claude models in the Codex App mobile model picker" />
  <img src="docs/screenshots/mobile-fable-response.png" width="30%" alt="Claude Fable responding in the Codex App mobile chat" />
  <img src="docs/screenshots/mobile-claude-usage-status.png" width="30%" alt="Claude usage limits in the Codex App mobile status sheet" />
</p>

> [!NOTE]
> CCodex is an independent, unofficial, community project. It is not affiliated with,
> sponsored, or endorsed by OpenAI or Anthropic. *Codex*, *Claude*, and related marks
> belong to their respective owners.

---

Want Fable and Opus writing your code, but prefer the Codex App and its remote sessions
from desktop and phone? CCodex puts the **native Claude Code harness** (official Claude
Agent SDK, your own Claude login) behind that UI. GPT chats still go to your installed
Codex unchanged. No CCodex servers, no telemetry; MIT-licensed.

> [!WARNING]
> CCodex is young. Expect bugs — and please [report them](https://github.com/gkorepanov/ccodex/issues).

## What you get

- **Claude models in the model picker**, next to `gpt-*` (ids `claude:…`), with Claude's
  effort levels and Fast mode. Codex's `ultra` effort runs Claude at `max` and has it
  delegate to sub-agents proactively, as stock does for GPT.
- **Switch providers mid-chat.** Pick a GPT model in a Claude chat (or the other way
  round) and the conversation is compacted into a summary that the other provider
  continues from. The App keeps showing one chat with one history; edits and forks across
  the switch work.
- **Codex App features on Claude chats**: approvals, Plan mode, `/goal`, `/compact`, fork,
  message edits, steering and queued messages, Stop, side chats (`/side`, served by
  Claude's `/btw`), images, Claude's questions as the App's question prompts, its task
  list as the turn's to-do list, and thinking as reasoning summaries.
- **Sub-agents and background commands like stock's**: Claude sub-agents open as their
  own threads, background shell commands show as background terminals, and messages
  between Claude chats show as the App's messages between tasks.
- **Claude skills in the `$` picker**, beside Codex skills, in Claude and GPT chats.
- **Search**: the sidebar search and find-in-chat cover Claude chats too.
- **Phone**: turn on remote control in the Codex App (or
  `codex app-server daemon enable-remote-control` on the host) and pair the ChatGPT
  mobile app as usual; it drives Claude chats like GPT ones.
- **Your `claude` CLI sessions show up** in the App, and chats from the App resume in
  `claude --resume <id>` (a Claude chat's id is its Claude session id). While another live
  Claude process has a chat open, the App can't start a turn in it.
- **Claude can delegate to Codex** through the `codex-wrapper` agent that setup installs;
  what Codex does streams into the Claude chat.
- **`/cc` status card** (also `/ccstatus`, `/ccodex`, `/ccstate`, with or without the
  slash, or *CCodex status* in the `/` menu): the chat's model, effort, permission mode,
  context use, session state, and Claude and Codex plan limits. Sent while a turn runs,
  it answers at once and never reaches the model.
- **Emoji thread titles** from a small GPT model and an editable prompt; Claude chats get
  a ` ✳️` suffix.

## Install

### Requirements

| | |
|---|---|
| **OS** | macOS 11+ on Apple silicon · Linux x64 or arm64 with glibc ≥ 2.31 (no Alpine/musl) · Bash, Zsh or Fish |
| **Node.js** | `>=22.13 <27` (22 or 24 LTS recommended), npm `>=10` |
| **Codex CLI** | any recent version; installed for you if missing. Tested with `0.156` and `0.157` |
| **Claude Code** | nothing to install: the Agent SDK brings it (`0.3.280` / Claude Code `2.1.280`) |

Don't run the installer or setup as root or with `sudo`.

### 1. Install

Either the script (it checks the platform, installs `@openai/codex` if there is no
`codex`, then runs `ccodex setup`):

```sh
curl -fsSL https://github.com/gkorepanov/ccodex/releases/latest/download/install.sh | sh
```

or npm:

```sh
npm install -g @gkorepanov/ccodex
ccodex setup
```

### 2. Log in

Skip what you are already logged in to; rerun any time:

```sh
ccodex auth codex     # codex login
ccodex auth claude    # Claude Code login (the SDK's bundled claude)
```

### 3. Activate

Open a new shell, then restart the gateway:

```sh
codex app-server daemon restart
```

- **Codex App over SSH:** reconnect to the host. The App finds CCodex's `codex` first on
  `PATH` (and at `~/.local/bin/codex`).
- **Local Codex App on macOS:** fully quit the App (`Cmd+Q`) and open it again (or log
  out and back in).
- **Local Codex App on Linux:** setup doesn't configure it; start the App with
  `CODEX_CLI_PATH=~/.ccodex/bin/codex` in its environment.

### What setup changes

- Installs the version under `~/.ccodex/versions/` and the `codex` / `ccodex` shims in
  `~/.ccodex/bin`, which a managed block (`# >>> ccodex >>>`) puts first on `PATH` in your
  Bash, Zsh and Fish startup files.
- Links `~/.local/bin/codex` to the shim; a `codex` found there moves to
  `~/.ccodex/backups/remote-codex` and stays the Codex CCodex runs.
- macOS: sets `CODEX_CLI_PATH` for the local App (`launchctl setenv` plus a login
  LaunchAgent `dev.ccodex.codex-cli-path`), so the App starts CCodex instead of its bundled
  `codex`. The signed `.app` is never touched, so its auto-updates keep working.
- Claude Code: sets `cleanupPeriodDays: 36500` in `~/.claude/settings.json` when unset
  (Claude deletes transcripts older than 30 days by default, and with them your Claude
  chats), and installs the `codex-wrapper` agent, the `workforce` skill and the `codex` MCP
  server (user scope).
- In a terminal, offers to append the Formulas and Plots sections of
  [`claude/chat-formatting.md`](claude/chat-formatting.md) to `~/.claude/CLAUDE.md`, so
  Claude writes LaTeX and plots the way the App renders them.
- Never restarts a running gateway: a new version takes over after
  `codex app-server daemon restart`.

## Update, upgrade from 0.4, uninstall

```sh
ccodex update             # to npm latest; --check only reports, --next takes the pre-release
ccodex doctor             # health check (--json available)
ccodex uninstall          # keeps ~/.ccodex/config.toml and ~/.ccodex/state
ccodex uninstall --purge --yes   # also deletes ~/.ccodex
```

Uninstall stops CCodex's gateway and undoes the `PATH`, `~/.local/bin/codex` and
`CODEX_CLI_PATH` changes; what setup added to `~/.claude` stays. If `ccodex` is gone from
`PATH`, use the release's `uninstall.sh` (`… | sh -s -- --purge` to purge):
`curl -fsSL https://github.com/gkorepanov/ccodex/releases/latest/download/uninstall.sh | sh`

**From 0.4:** run `ccodex update` (or reinstall), then `codex app-server daemon restart`.
0.5 keeps no databases of its own; setup migrates 0.4's state once before it activates
0.5 (a failed migration activates nothing). Provider-switch history, archive flags,
sections and names carry over. Claude chats get their Claude session ids (links to 0.4
thread ids stop working), 0.4's side chats are archived, and chats whose transcripts
Claude's 30-day cleanup deleted come back as text. The 0.4 databases move to
`~/.ccodex.0.4-backup`.

## Settings

Claude chats follow the App's own controls:

| Codex App | Claude Code |
|---|---|
| *Full Access* / *Ask for approval* / *Approve for me* | permission mode `bypassPermissions` / `default` / `auto` |
| Plan mode | permission mode `plan` |
| Reasoning effort | effort (`ultra` = `max` + proactive sub-agents) |
| Fast | Claude fast mode |

`~/.ccodex/config.toml` (every key optional; all of them are in
[`examples/config.toml`](examples/config.toml)):

- `rename_prompt` — the title prompt; remove it for stock Codex titles (manual names
  always win). `title_model` — the model that writes them.
- `log_level` — `debug`, `info` (default), `warn`, `error`.
- `codex_binary`, `delegate_codex`, `claude_binary` — use a specific `codex` or `claude`.

## Troubleshooting

- `ccodex doctor` checks Node, Codex and Claude and their logins, the prebuilt native
  relay (`@gkorepanov/ccodex-relay-*`), the gateway and the install, and says what to run.
- `codex app-server daemon restart` restarts the gateway (chats running in it stop).
- The gateway's log is `~/.codex/app-server-daemon/app-server.stderr.log`, rewritten at
  each gateway start; set `log_level = "debug"` for more.
- For a bug report, `rpc_capture = true` records every App message to
  `~/.ccodex/state/rpc.jsonl` (mode `0600`, capped at 1 GiB, prompts and outputs
  included). Off by default; it never leaves your disk.
- The App's built-in `/status` differs by client (Desktop may show only its OpenAI account);
  `/cc` shows the same in every client.
- On a Mac, the local App replaces a gateway started from a terminal (or by an earlier App
  launch) with its own, so that Browser Use works; chats running in the old one stop.

## How it works

CCodex is a thin gateway in front of your installed `codex app-server`: the App starts
CCodex's `codex`, one stock app-server serves every GPT chat unchanged, and `claude:*`
chats run on the Claude Agent SDK with Claude's transcripts in `~/.claude/projects` as
their only source of truth. The only state CCodex adds is an optional
`~/.ccodex/state/meta.json` (provider-switch history, archive flags and sections of Claude
chats). Plain `codex …` commands (TUI, `exec`, `login`) run your installed Codex; `codex
mcp-server`, removed from Codex in `0.154`, is served by CCodex on top of `codex exec`.

## Development

```sh
npm ci --ignore-scripts
npm run check
npm test                  # unit and black-box gateway tests, relay tests
scripts/e2e/run.sh        # rootless podman, real models, copies of your credentials
```

## License

MIT — see [`LICENSE`](LICENSE). Third-party licenses and notices:
[`legal/LICENSES.md`](legal/LICENSES.md), [`legal/THIRD_PARTY_NOTICES.md`](legal/THIRD_PARTY_NOTICES.md).

<div align="center">
<sub>Claude Code'x is an independent open-source project — not affiliated with, sponsored, or endorsed by OpenAI or Anthropic.</sub>
</div>
