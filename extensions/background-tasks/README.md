# background-tasks

Claude Code-style background task support for [pi](https://pi.dev).

Run long-running shell commands without blocking the conversation. The model gets a
task ID immediately and can keep working; when the task exits, a completion
notification is injected into the conversation so the model reports the result on
its next turn — even if it already finished its previous response.

## Tools

| Tool | Description |
|------|-------------|
| `bash_background` | Start a shell command in the background. Returns a task ID and output file path immediately. Optional `timeout_ms` auto-stops the task. |
| `task_output` | Get a task's status + output tail. `block: true` waits for completion (up to `timeout_ms`, default 30s). |
| `task_stop` | Kill a running task (entire process tree — works on Windows via `taskkill /T /F`). |
| `task_list` | List all tasks from this session with status, exit codes, output files. |

## Human-facing TUI

- **Live task panel** below the editor while tasks exist: animated spinner, live elapsed time, right-aligned status/exit-code columns. Running tasks first; finished tasks linger ~60s then clear automatically.
- **`/tasks` command or `alt+t`** — interactive manager (SelectList): pick a task → view its output in a scrollable overlay (`↑↓` scroll, `←→` page, `esc` close) or stop it; `esc` backs out. Non-TUI modes get a plain text listing.
- Status-line entry showing running task count
- Colored completion notifications (green = completed, yellow = stopped, red = failed)

## Behavior details

- **Output**: streamed to a file in `<tmpdir>/pi-background-tasks/<task-id>.log` (also readable with the `read` tool). Capped at 50MB per task; further output is discarded (the process keeps running) with a note in the file.
- **Completion notifications**: delivered as a steering message while the agent is streaming (arrives before the model's next LLM call), or triggers a turn immediately when the agent is idle. Includes the last 2KB of output.
- **Cleanup**: all running tasks are killed when the session shuts down (quitting pi, `/new`, session switch). Output files persist in the OS temp dir.
- **Environment**: child processes receive `PI_BG_TASK_ID` alongside pi's standard session environment variables.
- **Windows**: process-tree kill via `taskkill`; elsewhere `SIGTERM` with `SIGKILL` fallback after 5s.

## Install

```bash
pi install git:github.com/ryan75195/pi-plugins
```

## Example

Ask pi:

> Start `npm run dev` in the background, then continue working. When it's up,
> curl the server to verify it responds, and stop the task afterwards.
