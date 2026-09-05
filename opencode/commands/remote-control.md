---
description: Register/unregister this session for Remote Control (continue from your phone or any browser on your tailnet)
agent: build
---

Use the `remote_control` tool to manage Remote Control. Decide from the arguments after "/remote-control":

1. **Empty, "on", or "start"** → call `remote_control` with action `on`. If the arguments contain a name, pass it.
2. **"off", "stop", "disconnect", "unregister"** → call `remote_control` with action `off`.
3. **"status"** → call `remote_control` with action `status`.

Report the tool's output verbatim — especially the URL and any enable link. Never invent or modify the URL. If the output says Serve is not enabled, tell the user to click the enable link first.

Arguments: $ARGUMENTS
