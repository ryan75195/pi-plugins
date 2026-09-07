# background-tasks (opencode)

Claude Code-style background task support for [opencode](https://opencode.ai) — the opencode
sibling of the pi extension in this repo. Same tools, same behavior, adapted to
opencode's plugin API.

## Tools

| Tool | Description |
|------|-------------|
| `bash_background` | Start a shell command in the background. Returns a task ID and output file path immediately. Optional `timeout_ms` auto-stops the task. |
| `task_output` | Get a task's status + output tail. `block: true` waits for completion (up to `timeout_ms`, default 30s). |
| `task_stop` | Kill a running task (entire process tree — Windows via `taskkill /T /F`, else SIGTERM→SIGKILL). |
| `task_list` | List all tasks with status, exit codes, output files. |

## Completion notifications

When a task exits, the plugin sends a notification message into the originating
session via `prompt_async`:

- **Session idle** → the message is sent immediately and the agent reacts on its own (reports the result, checks logs, etc.)
- **Session busy** → the notification is queued (tracked via `session.status` events) and flushed on the next `session.idle`
- Notifications include the task status, duration, exit code, and last 2KB of output
- The TUI also shows a toast (success/warning/error) via `client.tui.showToast` — best-effort, ignored outside TUI mode

## Behavior details

- **Output**: streamed to `<tmpdir>/opencode-background-tasks/<task-id>.log` (readable with opencode's `read` tool). 50MB cap per task; further output discarded with a note in the file.
- **Cleanup**: kill the process when stopping; Windows kills the whole process tree.
- **Environment**: children receive `OPENCODE_BG_TASK_ID`.
- No live task panel in the chat area, BUT: a **TUI sidebar section** ([tui/background-tasks-sidebar.tsx](tui/background-tasks-sidebar.tsx)) renders running/finished tasks in the right-hand panel (`ctrl+x b`), with live elapsed times and click-to-stop (confirmation dialog). Pairs with the server plugin via a shared state file.
- **`/processes` command** ([commands/processes.md](commands/processes.md), install to `~/.config/opencode/commands/`): appears in the TUI command menu. Shows a compact status table via `task_list`; supports `stop <id>`, `view <id>`, `stop all` arguments.

## Install

Copy or symlink into opencode's plugin directory:

```bash
# Global (all projects)
mkdir -p ~/.config/opencode/plugins
ln -s /path/to/pi-plugins/opencode/plugins/background-tasks.ts ~/.config/opencode/plugins/background-tasks.ts

# Or project-level
mkdir -p .opencode/plugins
cp /path/to/pi-plugins/opencode/plugins/background-tasks.ts .opencode/plugins/
```

No config needed — files in the plugin directory load automatically at startup.

### Global agent policy (AGENTS.md)

`AGENTS.md` in this directory tells every opencode session to reach for
`monitor` instead of sleep/poll loops and to prefer `bash_background` for
long-running processes. Install it globally with the rest:

```bash
cp /path/to/pi-plugins/opencode/AGENTS.md ~/.config/opencode/AGENTS.md
```

(Existing global AGENTS.md: merge the two sections instead of overwriting.)

## Sidebar (TUI) install

The sidebar plugin renders a live "Background tasks" section in opencode's right-hand panel:

```bash
# 1. Dependencies for the TUI plugin (solid-js + @opentui/solid)
cd /path/to/pi-plugins/opencode/tui && npm install

# 2. Register it in ~/.config/opencode/tui.json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["C:/absolute/path/to/pi-plugins/opencode/tui/background-tasks-sidebar.tsx"]
}
```

Then open opencode, toggle the sidebar with `ctrl+x b`, and start a task with `bash_background` —
it appears with a live spinner, elapsed time and exit code; click a running row to stop it.

## Example

Ask opencode:

> Start `npm run dev` in the background, then keep working. When it's ready,
> curl the server to verify it responds, then stop the task.

## Remote Control (opencode, over Tailscale)

Claude Code `/remote-control` parity: register the current session and continue
it from a phone, tablet, or any browser on your tailnet. The session keeps
running locally; the remote client is a window into it.

- `opencode/plugins/remote-control.ts` — plugin; hosts a localhost-only
  endpoint inside the opencode server process (Bun.serve) and publishes it via
  `tailscale serve --bg` (tailnet-only, never public; token-gated on top).
- `opencode/commands/remote-control.md` — `/remote-control [name]`, `off`, `status`.

Every instance publishes under its own stable `/rc-<instance id>` path; the tailnet root is never claimed, so instances cannot replace each other's URL. Diagnostics: `%TEMP%\opencode-remoteemote-control.log` records every tailscale call and registration decision.

Setup: enable Tailscale Serve once (the plugin prints the enable link if it is
not on). Requires `tailscale` on PATH. Install with `npm run install:opencode`
(see below).

Architecture:

```
browser on tailnet ──https://<host>.ts.net/rc-<id>/?t=<token>──► tailscale serve ──►
127.0.0.1:<port> Bun.serve (plugin) ── SDK ──► session (promptAsync/messages)
```

The web client lists sessions, streams the transcript, opens new sessions, and
queues messages mid-turn (delivered after the current turn, like Claude Code).

### Pairing (phone app)

A phone pairs **once per machine**, not once per session. After that, every
instance that runs `/remote-control` shows up in the app on its own and
disappears again on `/remote-control off`.

```
/remote-control pair            # prints the pair URL — paste it into the app once
/remote-control rotate-pairing  # mint a new token (the old one stops working)
```

The pair URL is

```
https://<tailnet-host>/rc-hub/?t=<pairingToken>
```

The pairing token is machine-scoped and durable: it lives in
`~/.config/opencode/remote-control/machine.json` as
`{ "pairingToken": "…", "createdAt": 1757… }`, is minted on first use, and
survives restarts. Every instance endpoint accepts either its own instance
token or the pairing token, through `?t=`, the `x-oc-token` header, or Basic
`opencode:<token>`.

Opening the pair URL in a browser is also a quick check that pairing works —
it renders a "Paired" page listing the instances currently running.

### Hub endpoint

The hub is what makes "pair once" work: one endpoint per machine, on fixed
port **8579**, published at `/rc-hub` and gated by the pairing token alone
(instance ports start at 8580, so they never collide). Instance tokens are
never returned by it.

| Route | Response |
|-------|----------|
| `GET /health` | `{ "ok": true }` |
| `GET /instances` | `{ machine: { host, name }, instances: […] }` |
| `GET /` | small "Paired" page listing the instances |

`GET /instances` returns, per instance: `id`, `name`, `directory`, `host`,
`mount` (`/` or `/rc-xxxxxx`), `port`, `defaultSession`, `startedAt`, and
`alive` (the pid is alive **and** the port answers). `id` is derived from the
working directory, so it is stable across restarts and an app can keep
per-instance state against it.

No instance owns the hub. The first registered process that can bind 8579
hosts it; every registered process runs a 3-second watchdog and rebinds if the
port goes quiet, so the hub survives whichever instance happens to exit. The
`/rc-hub` tailscale mount is removed only when the last registration goes away.

## Install (opencode plugins + commands)

```bash
npm run install:opencode
```

Copies `opencode/plugins/*.ts` → `~/.config/opencode/plugins/` and
`opencode/commands/*.md` → `~/.config/opencode/commands/`, printing what it
copied. These are **copies, not symlinks**, so:

> Run `npm run install:opencode` after every merge, then restart running
> opencode instances to pick up the new code.
