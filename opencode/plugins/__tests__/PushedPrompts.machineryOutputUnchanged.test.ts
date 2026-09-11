/**
 * Contract: the loop, goal, monitor and background-task behaviours are
 * otherwise unchanged. Marking a push is metadata-only: the pushed text and
 * the message formats the machinery has always produced are untouched, and the
 * existing goal/loop regression suites continue to pin their timing and
 * terminal behaviour.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, turnFinished, runTool } from "./helpers.ts"
import {
  makeMonitorPushHarness,
  makeBackgroundPushHarness,
  textPartMatching,
  waitForPush,
} from "./pushedPrompts.ts"

test("The goal evaluation notice keeps its wording and carries no marker text", async () => {
  const { plugin, calls } = await makeHarness()
  const sessionID = "ses-unchanged-goal"
  const condition = "the goal wording is unchanged"
  await runTool(plugin, "goal_set", { condition }, sessionID)
  await turnFinished(plugin, sessionID)

  const push = calls.dispatched.find((d) => d.text.includes("Goal evaluation"))
  assert.ok(push, "the goal evaluation notice must still be pushed")
  const part = textPartMatching(push, (text) => text.includes("Goal evaluation"))
  assert.ok(part?.text, "the notice must still be a text part")
  assert.ok(part.text.includes("NOT YET MET"), "the notice keeps its NOT YET MET wording")
  assert.ok(part.text.includes(condition), "the notice still carries the condition")
  assert.equal(part.text.includes("machinePushed"), false, "the marker must live in metadata, not in the text")
})

test("The loop iteration prompt is delivered verbatim", async () => {
  const { plugin, calls } = await makeHarness()
  const prompt = "verbatim loop prompt: keep going"
  await runTool(plugin, "loop", { prompt, max_iterations: 1 }, "ses-unchanged-loop")

  const push = calls.dispatched.find((d) => d.text === prompt)
  assert.ok(push, "the loop prompt must still be pushed verbatim")
  assert.equal(push.text, prompt, "the loop prompt text must be unchanged")
  assert.equal(push.text.includes("machinePushed"), false, "the marker must not leak into the loop text")
})

test("The monitor event keeps its [monitor ...] format and carries no marker text", async () => {
  const { plugin, pushes } = await makeMonitorPushHarness()
  await runTool(plugin, "monitor", { command: "printf 'unchanged-monitor-line\\n'", description: "unchanged monitor" }, "ses-unchanged-monitor")

  const push = await waitForPush(pushes, (p) =>
    p.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes("unchanged monitor")),
  )
  const part = textPartMatching(push, (text) => text.includes("unchanged monitor"))
  assert.ok(part?.text, "the monitor event must still be a text part")
  assert.ok(part.text.startsWith("[monitor "), "the monitor event keeps its [monitor ...] format")
  assert.ok(part.text.includes("ended:"), "the monitor event keeps its ended notice")
  assert.equal(part.text.includes("machinePushed"), false, "the marker must not leak into the monitor text")
  await plugin.dispose?.()
})

test("The background-task completion keeps its notification format and carries no marker text", async () => {
  const { plugin, pushes } = await makeBackgroundPushHarness()
  await runTool(plugin, "bash_background", { command: "printf 'unchanged-background-line'", description: "unchanged background" }, "ses-unchanged-background")

  const push = await waitForPush(pushes, (p) =>
    p.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes("Background task")),
  )
  const part = textPartMatching(push, (text) => text.includes("Background task"))
  assert.ok(part?.text, "the completion must still be a text part")
  assert.ok(part.text.startsWith("Background task "), "the completion keeps its notification format")
  assert.ok(part.text.includes("completed"), "the completion still reports the completed status")
  assert.equal(part.text.includes("machinePushed"), false, "the marker must not leak into the notification text")
  await plugin.dispose?.()
})
