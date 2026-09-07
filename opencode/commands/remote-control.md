---
description: Toggle Remote Control (continue this session from your phone or any browser on your tailnet)
agent: build
---

Use the `remote_control` tool to manage Remote Control. Decide from the arguments after "/remote-control":

1. **Empty or "toggle"** → call `remote_control` with action `toggle`. It connects when off and disconnects when on. If the arguments contain a name, pass it (only meaningful when connecting).
2. **"on", "start"** → action `on`.
3. **"off", "stop", "disconnect", "unregister"** → action `off`.
4. **"status"** → action `status`.
5. **"pair"** → action `pair`. Prints the machine pair URL to paste into the phone app once.
6. **"rotate-pairing", "rotate"** → action `rotate-pairing`. Mints a new pairing token (the old one stops working, so the app has to be re-paired).

Report the tool's output verbatim — especially the URL and any enable link. Never invent or modify the URL. If the output says Serve is not enabled, tell the user to click the enable link first.

Arguments: $ARGUMENTS
