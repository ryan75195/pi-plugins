# Global agent guidance

The plugins in this repo (`background-tasks`, `monitor`, `remote-control`) are written for the opencode 2.3 plugin API (`export default Plugin.define({ id, setup })`). Each injects its own usage guidance into the system prompt of every request from a `ctx.session.hook("context", …)` callback that pushes one text part onto `c.system` (once, skipping it if already present), so their decision rules do not need to be repeated here.

`background-tasks` also replaces opencode's built-in `shell` tool: its tool transform removes `shell` and registers `bash` (top-level, not in code mode), so the model has one shell tool whose long commands can be moved to the background. Completion notices from `background-tasks` and `monitor` arrive as queued synthetic messages (`ctx.session.synthetic`) that wake the session.
