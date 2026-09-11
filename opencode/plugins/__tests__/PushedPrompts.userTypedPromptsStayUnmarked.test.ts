/**
 * Contract: a prompt the user types carries no machine-pushed marker. The
 * phone client submits user prompts through the plugin's /api/send route,
 * which forwards a plain text part; only the loop/goal/monitor/background
 * machinery marks its own pushes.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, turnFinished, runTool } from "./helpers.ts"
import { isMachinePushed, type CapturedPart } from "./pushedPrompts.ts"
import { openTestInstance } from "../../test/helpers/instance.ts"

test("A user-typed prompt stays unmarked while a machine push is marked", async () => {
  const instance = await openTestInstance({ sessions: [{ id: "ses-phone-user", title: "mobile" }] })
  const res = await instance.request("POST", "/api/send", {
    body: { session: "ses-phone-user", text: "typed by the user on the phone" },
  })
  assert.equal(res.status, 200, "the user prompt must be accepted")

  const forwarded = instance.fake.prompts.find((p) => p.id === "ses-phone-user")
  assert.ok(forwarded, "the user prompt must be forwarded to the session")
  const forwardedParts = (forwarded.body as { parts: CapturedPart[] }).parts
  const userPart = forwardedParts.find((part) => part.type === "text" && part.text === "typed by the user on the phone")
  assert.ok(userPart, "the user's text must be forwarded as a text part")
  assert.equal(isMachinePushed(userPart), false, "a user-typed prompt must not carry the machine-pushed marker")

  const { plugin, calls } = await makeHarness()
  const sessionID = "ses-positive-control"
  await runTool(plugin, "goal_set", { condition: "the marker is opt-in" }, sessionID)
  await turnFinished(plugin, sessionID)
  const machinePush = calls.dispatched.find((d) => d.text.includes("Goal evaluation"))
  assert.ok(machinePush, "a machine push must be observable as the positive control")
  const machinePart = machinePush.parts.find(
    (part) => part.type === "text" && typeof part.text === "string" && part.text.includes("Goal evaluation"),
  )
  assert.ok(machinePart, "the machine push must carry its text part")
  assert.equal(isMachinePushed(machinePart), true, "a machine push must carry the marker the user prompt lacks")
})
