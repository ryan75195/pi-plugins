/**
 * Contract: a session loop re-runs its prompt on the chosen cadence (fixed
 * interval or self-paced) until its stop condition holds or its iteration cap
 * is reached.
 *
 * Cadence is asserted through observable prompt dispatches on node:test's
 * mocked clock, never through internals.
 */
import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, settle, turnFinished, runTool, runsOf } from "./helpers.ts"

const PROMPT = "re-run the smoke checks and report every failure"
const UNTIL = "the smoke checks pass end to end"

test("A started loop runs its prompt immediately and re-runs it on the fixed cadence", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m", until: UNTIL }, "ses-fixed-cadence")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "the loop must run its prompt once at start")
		mock.timers.tick(4 * 60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "no re-run before the cadence elapses")
		mock.timers.tick(60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "the prompt re-runs after one cadence period")
	} finally {
		mock.timers.reset()
	}
})

test("A self-paced loop re-runs its prompt five minutes after each turn", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, until: UNTIL }, "ses-self-paced")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "the loop must run its prompt once at start")
		await turnFinished(plugin, "ses-self-paced")
		mock.timers.tick(4 * 60_000 + 59_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "the next self-paced run waits for the default interval after the turn")
		mock.timers.tick(1_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "a self-paced loop re-runs after the five minute default")
	} finally {
		mock.timers.reset()
	}
})

test("A sub-minute cadence is clamped up to the sixty second floor", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "10s", until: UNTIL }, "ses-clamped")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1)
		mock.timers.tick(10_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "a 10s cadence must not re-run at ten seconds")
		mock.timers.tick(50_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "a 10s cadence re-runs at the sixty second floor instead")
	} finally {
		mock.timers.reset()
	}
})

test("A ninety second cadence re-runs after ninety seconds", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "90s", until: UNTIL }, "ses-ninety-seconds")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1)
		mock.timers.tick(89_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1)
		mock.timers.tick(1_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "the 90s interval re-runs the prompt at ninety seconds")
	} finally {
		mock.timers.reset()
	}
})

test("A two hour cadence re-runs after two hours", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "2h", until: UNTIL }, "ses-two-hours")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1)
		mock.timers.tick(2 * 60 * 60_000 - 1_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1)
		mock.timers.tick(1_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "the 2h interval re-runs the prompt after two hours")
	} finally {
		mock.timers.reset()
	}
})

test("A loop stops once its iteration cap is reached", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m", until: UNTIL, max_iterations: 2 }, "ses-capped")
		mock.timers.tick(1)
		await settle()
		await turnFinished(plugin, "ses-capped")
		mock.timers.tick(5 * 60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2)
		await turnFinished(plugin, "ses-capped")
		mock.timers.tick(5 * 60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "the iteration cap stops further prompt runs")
		await turnFinished(plugin, "ses-capped")
		mock.timers.tick(30 * 60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "a capped loop never re-runs its prompt again")
	} finally {
		mock.timers.reset()
	}
})

test("A loop without a stop condition still stops at the default iteration cap", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m" }, "ses-unbounded")
		mock.timers.tick(1)
		await settle()
		for (let i = 0; i < 45; i++) {
			mock.timers.tick(5 * 60_000)
			await settle()
		}
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 40, "a loop with no until condition stops at the default cap of 40 iterations")
		mock.timers.tick(60 * 60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 40, "the capped loop stays stopped")
	} finally {
		mock.timers.reset()
	}
})
