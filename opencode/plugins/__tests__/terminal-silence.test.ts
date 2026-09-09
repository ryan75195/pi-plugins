/**
 * Contract: terminal states end silently. A finished (until judged MET or
 * iteration cap), stopped (loop_stop), failed (IMPOSSIBLE), achieved, or
 * cleared loop or goal never starts another turn — the repo plugin's own
 * terminal handling, not the config copy's dispatch-on-terminal storm.
 */
import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, settle, turnFinished, runTool, runsOf } from "./helpers.ts"

const PROMPT = "keep the release notes in sync with the changelog"
const UNTIL = "the release notes match the changelog"

test("A loop that reached its stop condition never starts another turn", async () => {
	const { plugin, calls } = await makeHarness({ verdicts: ["MET: the release notes match the changelog"] })
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m", until: UNTIL }, "ses-loop-finished")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1)
		const beforeStop = calls.dispatched.length
		await turnFinished(plugin, "ses-loop-finished")
		assert.ok(
			calls.evaluatorPrompts.some((p) => p.includes(UNTIL)),
			"the stop condition must be judged by the evaluator",
		)
		assert.ok(
			calls.dispatched.length - beforeStop <= 1,
			"the loop ends with at most one final dispatch, never a burst of stop prompts",
		)
		const afterStop = calls.dispatched.length
		for (let i = 0; i < 5; i++) await turnFinished(plugin, "ses-loop-finished")
		mock.timers.tick(3 * 5 * 60_000)
		await settle()
		assert.equal(calls.dispatched.length, afterStop, "a finished loop stays silent on further idles and cadence ticks")
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "the loop prompt never re-runs after the condition holds")
	} finally {
		mock.timers.reset()
	}
})

test("A loop stopped with loop_stop never starts another turn", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m", until: UNTIL }, "ses-loop-stopped")
		mock.timers.tick(1)
		await settle()
		await runTool(plugin, "loop_stop", {}, "ses-loop-stopped")
		await settle()
		const afterStop = calls.dispatched.length
		for (let i = 0; i < 3; i++) await turnFinished(plugin, "ses-loop-stopped")
		mock.timers.tick(2 * 5 * 60_000)
		await settle()
		assert.equal(calls.dispatched.length, afterStop, "a stopped loop dispatches nothing on further idles or ticks")
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "a stopped loop never re-runs its prompt")
	} finally {
		mock.timers.reset()
	}
	await runTool(plugin, "loop_stop", {}, "ses-without-a-loop")
})

test("Disposing the plugin cancels every loop timer it created", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m", until: UNTIL }, "ses-loop-disposed")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1)
		await plugin.dispose()
		await settle()
		const afterDispose = calls.dispatched.length
		mock.timers.tick(3 * 5 * 60_000)
		await settle()
		for (let i = 0; i < 3; i++) await turnFinished(plugin, "ses-loop-disposed")
		assert.equal(calls.dispatched.length, afterDispose, "a disposed plugin never starts another loop turn")
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "no loop timer survives dispose")
	} finally {
		mock.timers.reset()
	}
})

test("An achieved goal never starts another turn", async () => {
	const { plugin, calls } = await makeHarness({ verdicts: ["MET: all the tests are green"] })
	await runTool(plugin, "goal_set", { condition: "all the tests are green" }, "ses-goal-achieved")
	await turnFinished(plugin, "ses-goal-achieved")
	assert.ok(calls.dispatched.some((d) => d.text.includes("Goal achieved")), "the achievement is announced once")
	const afterAchieved = calls.dispatched.length
	for (let i = 0; i < 5; i++) await turnFinished(plugin, "ses-goal-achieved")
	assert.equal(calls.dispatched.length, afterAchieved, "no further turns after the goal is achieved")
})

test("A goal marked impossible never starts another turn", async () => {
	const { plugin, calls } = await makeHarness({ verdicts: ["IMPOSSIBLE: the condition contradicts the codebase"] })
	await runTool(plugin, "goal_set", { condition: "the moon turns green" }, "ses-goal-impossible")
	await turnFinished(plugin, "ses-goal-impossible")
	assert.ok(calls.dispatched.some((d) => /impossible/i.test(d.text)), "the failure is reported once")
	const afterFailed = calls.dispatched.length
	for (let i = 0; i < 5; i++) await turnFinished(plugin, "ses-goal-impossible")
	assert.equal(calls.dispatched.length, afterFailed, "no further turns after the goal is marked impossible")
})

test("A cleared goal never starts another turn", async () => {
	const { plugin, calls } = await makeHarness()
	await runTool(plugin, "goal_set", { condition: "the build is green" }, "ses-goal-cleared")
	await runTool(plugin, "goal_clear", {}, "ses-goal-cleared")
	const afterClear = calls.dispatched.length
	for (let i = 0; i < 5; i++) await turnFinished(plugin, "ses-goal-cleared")
	assert.equal(calls.dispatched.length, afterClear, "no further turns after the goal is cleared")
})
