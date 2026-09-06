# Global agent guidance

## Long-running waits: use the monitor tool
When you would otherwise sleep, poll in a loop, or repeatedly re-run a command to wait for something (dev server ready, tests/CI to finish, a log line to appear, a file to change), use the `monitor` tool instead and keep the turn moving. Write the watch command so it prints only the interesting lines, and react to `[monitor …]` events as they arrive. Stop watches with `monitor_stop` when they are no longer relevant.

## Background tasks
Prefer the `bash_background` tool for long-running processes the user doesn't need to wait for (servers, builds, watch jobs); report completion automatically. Use plain `bash` only for quick commands.
