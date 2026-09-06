---
description: Watch something in the background (log, CI status, dev server) and react when output changes
agent: build
---

Use the `monitor` tool to start background watches, `monitor_stop` to cancel. Decide from the arguments after "/monitor":

1. **Empty** → call `monitor_stop` with id `all`? No — first there may be nothing to stop: report that you can list/stop watches, and ask what they want watched. If active watches were started in this session, mention their ids.
2. **"stop", "off", "cancel"** → call `monitor_stop` with the id from the arguments, or `all` if none given.
3. **Anything else** → start a watch: call `monitor` with a `command` that prints ONLY the interesting lines (filter inside the command with grep/Select-String/tail as appropriate), a short `description`, and a `pattern` when the user names a specific thing to match (e.g. READY, error). For polling (CI, PRs, URLs) write a loop command that prints one line per state change, not a line per poll. Prefer `persistent` only when the user asks for indefinite watching.
4. When `[monitor …]` event messages arrive later in the conversation, treat them as real events: report or act on them immediately, without re-running the watch command.

Arguments: $ARGUMENTS
