/**
 * Contract: a prompt pushed by the loop, goal, monitor and background-task
 * machinery still reaches the model and still drives the turn. The pushed text
 * is sent as an ordinary text part, not one that opencode excludes from model
 * context (synthetic/ignored), and the push still goes through promptAsync,
 * which is what starts the turn.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, turnFinished, runTool } from "./helpers.ts"
import {
  makeMonitorPushHarness,
  makeBackgroundPushHarness,
  textPartMatching,
  waitForPush,
  type CapturedPart,
} from "./pushedPrompts.ts"

function assertModelVisibleTextPart(part: CapturedPart | undefined, description: string): void {
  assert.ok(part, `${description}: the pushed text must arrive as a text part`)
  assert.equal(part.type, "text", `${description}: the pushed part must be a text part`)
  assert.notEqual(part.synthetic, true, `${description}: a synthetic part is not in the model context`)
  assert.notEqual(part.ignored, true, `${description}: an ignored part is not in the model context`)
}

test("A goal evaluation notice reaches the model and starts the next turn", async () => {
  const { plugin, calls } = await makeHarness()
  const sessionID = "ses-reach-goal"
  const condition = "the pushed goal notice still reaches the model"
  await runTool(plugin, "goal_set", { condition }, sessionID)
  await turnFinished(plugin, sessionID)

  const push = calls.dispatched.find((d) => d.text.includes("Goal evaluation"))
  assert.ok(push, "the goal evaluation notice must be pushed with promptAsync")
  assertModelVisibleTextPart(textPartMatching(push, (text) => text.includes("Goal evaluation")), "goal notice")
  assert.equal(push.sessionID, sessionID, "the goal notice must go to the goal's session")
})

test("A loop iteration prompt reaches the model and starts the next turn", async () => {
  const { plugin, calls } = await makeHarness()
  const sessionID = "ses-reach-loop"
  const prompt = "ship the pushed-loop contract"
  await runTool(plugin, "loop", { prompt, max_iterations: 1 }, sessionID)

  const push = calls.dispatched.find((d) => d.text === prompt)
  assert.ok(push, "the loop prompt must be pushed with promptAsync")
  assertModelVisibleTextPart(textPartMatching(push, (text) => text === prompt), "loop prompt")
  assert.equal(push.sessionID, sessionID, "the loop prompt must go to the loop's session")
})

test("A monitor event reaches the model and starts the next turn", async () => {
  const { plugin, pushes } = await makeMonitorPushHarness()
  const sessionID = "ses-reach-monitor"
  await runTool(plugin, "monitor", { command: "printf 'reach-monitor-line\\n'", description: "reach monitor" }, sessionID)

  const push = await waitForPush(pushes, (p) =>
    p.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes("reach monitor")),
  )
  assertModelVisibleTextPart(textPartMatching(push, (text) => text.includes("reach monitor")), "monitor event")
  assert.equal(push.sessionID, sessionID, "the monitor event must go to the watch's session")
  await plugin.dispose?.()
})

test("A background-task completion reaches the model and starts the next turn", async () => {
  const { plugin, pushes } = await makeBackgroundPushHarness()
  const sessionID = "ses-reach-background"
  await runTool(plugin, "bash_background", { command: "printf 'reach-background-line'", description: "reach background" }, sessionID)

  const push = await waitForPush(pushes, (p) =>
    p.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes("Background task")),
  )
  assertModelVisibleTextPart(textPartMatching(push, (text) => text.includes("Background task")), "background completion")
  assert.equal(push.sessionID, sessionID, "the background notification must go to the task's session")
  await plugin.dispose?.()
})
