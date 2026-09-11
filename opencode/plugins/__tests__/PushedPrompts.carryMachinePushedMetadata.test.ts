/**
 * Contract: each prompt the loop, goal, monitor and background-task machinery
 * pushes is stored carrying a marker identifying it as machine-pushed. The
 * marker rides on the pushed text part's `metadata`, a channel opencode
 * persists and a client already receives, and the pushed text is unchanged.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, turnFinished, runTool } from "./helpers.ts"
import {
  makeMonitorPushHarness,
  makeBackgroundPushHarness,
  isMachinePushed,
  textPartMatching,
  waitForPush,
  type CapturedPart,
} from "./pushedPrompts.ts"

function assertMarkedTextPart(part: CapturedPart | undefined, description: string): void {
  assert.ok(part, `${description}: the pushed text part must be present`)
  assert.equal(isMachinePushed(part), true, `${description}: the pushed text part must carry the machine-pushed marker`)
  assert.ok(part.text && part.text.length > 0, `${description}: the marker must ride on the pushed text, not replace it`)
}

test("A goal evaluation notice carries the machine-pushed marker", async () => {
  const { plugin, calls } = await makeHarness()
  const sessionID = "ses-marker-goal"
  await runTool(plugin, "goal_set", { condition: "the goal notice carries the marker" }, sessionID)
  await turnFinished(plugin, sessionID)

  const push = calls.dispatched.find((d) => d.text.includes("Goal evaluation"))
  assert.ok(push, "the goal evaluation notice must be pushed")
  assertMarkedTextPart(textPartMatching(push, (text) => text.includes("Goal evaluation")), "goal notice")
})

test("A loop iteration prompt carries the machine-pushed marker", async () => {
  const { plugin, calls } = await makeHarness()
  const sessionID = "ses-marker-loop"
  const prompt = "the loop prompt carries the marker"
  await runTool(plugin, "loop", { prompt, max_iterations: 1 }, sessionID)

  const push = calls.dispatched.find((d) => d.text === prompt)
  assert.ok(push, "the loop prompt must be pushed")
  assertMarkedTextPart(textPartMatching(push, (text) => text === prompt), "loop prompt")
})

test("A monitor event carries the machine-pushed marker", async () => {
  const { plugin, pushes } = await makeMonitorPushHarness()
  const sessionID = "ses-marker-monitor"
  await runTool(plugin, "monitor", { command: "printf 'marker-monitor-line\\n'", description: "marker monitor" }, sessionID)

  const push = await waitForPush(pushes, (p) =>
    p.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes("marker monitor")),
  )
  assertMarkedTextPart(textPartMatching(push, (text) => text.includes("marker monitor")), "monitor event")
  await plugin.dispose?.()
})

test("A background-task completion carries the machine-pushed marker", async () => {
  const { plugin, pushes } = await makeBackgroundPushHarness()
  const sessionID = "ses-marker-background"
  await runTool(plugin, "bash_background", { command: "printf 'marker-background-line'", description: "marker background" }, sessionID)

  const push = await waitForPush(pushes, (p) =>
    p.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes("Background task")),
  )
  assertMarkedTextPart(textPartMatching(push, (text) => text.includes("Background task")), "background completion")
  await plugin.dispose?.()
})
