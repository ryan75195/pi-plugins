---
description: Set, check, or clear a completion goal the agent works toward autonomously
agent: build
---

This command manages the session goal. You MUST use the goal tools — never simulate the goal, never just do the work without setting it.

Decide based on the arguments after "/goal":

1. **Empty or "status"** → call `goal_status` and report its output verbatim.
2. **"clear", "stop", "off", "reset", "none", "cancel"** → call `goal_clear` and report its output.
3. **Anything else** → this is a condition. Follow this order EXACTLY:
   - FIRST tool call: `goal_set` with the arguments as the condition (do nothing else before it — no analysis, no file reads, no writes).
   - THEN work toward the condition. After each of your turns an evaluator checks the condition automatically. If it is not yet met you will receive guidance as a message — continue working immediately without asking the user.
   - Only stop when the evaluator reports MET, or the goal is paused/cleared.

Arguments: $ARGUMENTS
