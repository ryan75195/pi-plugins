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
