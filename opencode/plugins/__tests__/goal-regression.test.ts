/**
 * Contract: existing /goal behaviour is unchanged — set, status, clear, the
 * no-tool-streak pause, the turn cap, and idle deferral while background work
 * runs all behave exactly as before the loop machinery joined the plugin.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, turnFinished, runTool, seedRunningBackgroundTask } from "./helpers.ts"

test("Setting a goal records the condition and goal_status reports it", async () => {
	const { plugin } = await makeHarness()
	const condition = "all tests in test/auth pass"
	const setReply = await runTool(plugin, "goal_set", { condition }, "ses-goal-set")
	assert.ok(setReply.includes("Goal set"), "setting a goal must confirm it")
	assert.ok(setReply.includes(condition), "the confirmation echoes the condition")
	const status = await runTool(plugin, "goal_status", {}, "ses-goal-set")
	assert.ok(status.includes("◎ Goal active"), "the goal is active right after being set")
	assert.ok(status.includes(condition), "status reports the condition")
	assert.ok(status.includes("turns evaluated: 0"), "a fresh goal has evaluated no turns")
})

test("Clearing a goal reports the cleared condition and status shows paused", async () => {
	const { plugin } = await makeHarness()
	const condition = "the build is green"
	await runTool(plugin, "goal_set", { condition }, "ses-goal-clear")
	const clearReply = await runTool(plugin, "goal_clear", {}, "ses-goal-clear")
	assert.ok(clearReply.includes("Goal cleared:"), "clearing reports the cleared goal")
	assert.ok(clearReply.includes(condition), "the cleared condition is echoed")
	const status = await runTool(plugin, "goal_status", {}, "ses-goal-clear")
	assert.ok(status.includes("◎ Goal paused"), "a cleared goal is paused")
	assert.ok(status.includes(condition), "the paused status still shows the condition")
})

test("Three turns without tool use pause the goal", async () => {
	const { plugin, calls } = await makeHarness({
		transcript: [{ info: { role: "assistant" }, parts: [{ type: "text", text: "I thought about the problem some more." }] }],
	})
	await runTool(plugin, "goal_set", { condition: "the migration is done" }, "ses-goal-stalled")
	for (let i = 0; i < 3; i++) await turnFinished(plugin, "ses-goal-stalled")
	assert.ok(
		calls.dispatched.some((d) => d.text.includes("Goal paused") && d.text.includes("without tool use")),
		"three tool-less turns must pause the goal",
	)
	const afterPause = calls.dispatched.length
	await turnFinished(plugin, "ses-goal-stalled")
	await turnFinished(plugin, "ses-goal-stalled")
	assert.equal(calls.dispatched.length, afterPause, "a paused goal dispatches nothing until the user resumes it")
})

test("A goal stops after forty evaluated turns", async () => {
	const { plugin, calls } = await makeHarness({
		transcript: [{ info: { role: "assistant" }, parts: [{ type: "tool", state: { input: { command: "npm test" } } }] }],
	})
	await runTool(plugin, "goal_set", { condition: "the fuzzing finds nothing" }, "ses-goal-capped")
	for (let i = 0; i < 40; i++) await turnFinished(plugin, "ses-goal-capped")
	assert.ok(
		calls.dispatched.some((d) => d.text.includes("stopped after 40 turns")),
		"the fortieth evaluated turn must stop the goal",
	)
	const afterCap = calls.dispatched.length
	await turnFinished(plugin, "ses-goal-capped")
	await turnFinished(plugin, "ses-goal-capped")
	assert.equal(calls.dispatched.length, afterCap, "a goal stopped by the turn cap dispatches nothing further")
})

test("Background work defers goal evaluation for three idle turns and evaluates on the fourth", async () => {
	const { plugin, calls } = await makeHarness()
	const sessionID = "ses-goal-deferred"
	seedRunningBackgroundTask(sessionID)
	const condition = "the linter is clean"
	await runTool(plugin, "goal_set", { condition }, sessionID)
	for (let i = 0; i < 3; i++) await turnFinished(plugin, sessionID)
	assert.equal(calls.evaluatorSessions.length, 0, "evaluation is deferred while background work runs")
	await turnFinished(plugin, sessionID)
	assert.ok(calls.evaluatorSessions.length >= 1, "the fourth idle evaluates despite the running background task")
	assert.ok(
		calls.evaluatorPrompts.some((p) => p.includes(condition)),
		"the evaluator is asked about the goal condition",
	)
})
