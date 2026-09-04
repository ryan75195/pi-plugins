---
description: Show background processes (status, output, stop)
agent: build
---

You are showing the user their background processes. Call the `task_list` tool, then render a compact status table:

```
ID       STATUS     TIME     COMMAND
✔ a1b2c3 completed  2.1s     echo hello
▶ d4e5f6 running    1m12s    npm run dev
```

Rules:
- Use the status icons: ▶ running, ✔ completed, ■ stopped, ✘ failed
- For failed/stopped tasks, include the exit code
- If there are no tasks, say "No background processes running." in one line
- Then list one line of available actions: `stop <id>` to kill a task, `view <id>` to show its output

If the command has arguments ($ARGUMENTS), interpret them:
- `stop <id>` (or just an id, if it is running): call `task_stop` with that id, then call `task_list` and show the updated table
- `view <id>` (or `out <id>`): call `task_output` with that id and `block: true`, show the output
- `kill all` / `stop all`: stop every running task, then show the table

Keep the response to the table plus at most two short lines.
