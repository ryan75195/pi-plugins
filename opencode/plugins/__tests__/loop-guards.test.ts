/**
 * Contract: a loop cannot run unbounded. It refuses to start without a stop
 * condition, every loop a session starts draws on one shared iteration
 * budget, and a loop stops when the session's recorded spend since it began
 * reaches the loop's dollar ceiling.
 *
 * Provenance: one recorded session chained "Babysit …" loops into 99 re-sent
 * prompts over 68 hours and $22.51 — more than any single factory run — with
 * the per-loop cap of 40 never binding because each new loop started at zero.
 */
import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, settle, runTool, runsOf } from "./helpers.ts"

const PROMPT = "babysit the factory queue and report what changed"
const UNTIL = "every ticket in the wave has merged"

test("A loop without a stop condition is refused and the refusal names until", async () => {
	const { plugin, calls } = await makeHarness()
	await assert.rejects(
		runTool(plugin, "loop", { prompt: PROMPT, every: "5m" }, "ses-no-until"),
		(err: Error) => /until/.test(err.message),
		"starting a loop with no until must be refused with a message naming the missing argument",
	)
	assert.equal(runsOf({ plugin, calls }, PROMPT).length, 0, "a refused loop dispatches nothing")
})

test("Loops started one after another share the session's iteration budget", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "1m", until: UNTIL, max_iterations: 30 }, "ses-chained")
		mock.timers.tick(1)
		await settle()
		for (let i = 0; i < 29; i++) {
			mock.timers.tick(60_000)
			await settle()
		}
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 30, "the first loop runs to its own cap")

		const second = await runTool(plugin, "loop", { prompt: PROMPT, every: "1m", until: UNTIL, max_iterations: 30 }, "ses-chained")
		assert.ok(second.includes("iteration 1 of 10"), `the second loop is capped to the 10 iterations the session has left: ${second}`)
		assert.ok(second.includes("capped"), "the start notice says the cap came from the session budget")
		mock.timers.tick(1)
		await settle()
		for (let i = 0; i < 12; i++) {
			mock.timers.tick(60_000)
			await settle()
		}
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 40, "the two loops together never exceed the session budget")

		await assert.rejects(
			runTool(plugin, "loop", { prompt: PROMPT, every: "1m", until: UNTIL }, "ses-chained"),
			(err: Error) => /budget/.test(err.message),
			"a third loop in the exhausted session is refused",
		)
	} finally {
		mock.timers.reset()
	}
})

test("A loop stops when the session's spend since it began reaches the ceiling", async () => {
	const later = Date.now() + 60_000
	const { plugin, calls } = await makeHarness({
		transcript: [
			{ info: { role: "assistant", cost: 0.75, time: { created: later } }, parts: [{ type: "tool", state: { input: { command: "gh pr list" } } }] },
			{ info: { role: "assistant", cost: 0.75, time: { created: later } }, parts: [{ type: "tool", state: { input: { command: "gh pr list" } } }] },
		],
	})
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		const started = await runTool(plugin, "loop", { prompt: PROMPT, every: "1m", until: UNTIL, max_spend_usd: 1 }, "ses-spend")
		assert.ok(started.includes("Spend ceiling: $1.00"), "the start notice states the ceiling")
		mock.timers.tick(1)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "the first iteration runs before any spend is recorded")
		mock.timers.tick(60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "no second iteration once $1.50 of spend stands against a $1.00 ceiling")
		assert.ok(
			calls.dispatched.some((d) => d.text.includes("Loop stopped") && d.text.includes("$1.50") && d.text.includes("$1.00")),
			"the stop notice reports the spend and the ceiling",
		)
		mock.timers.tick(5 * 60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 1, "a stopped loop stays stopped")
	} finally {
		mock.timers.reset()
	}
})

test("Spend before the loop began does not count against it", async () => {
	const earlier = Date.now() - 60_000
	const { plugin, calls } = await makeHarness({
		transcript: [{ info: { role: "assistant", cost: 5, time: { created: earlier } }, parts: [{ type: "tool", state: { input: { command: "npm test" } } }] }],
	})
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "1m", until: UNTIL, max_spend_usd: 1 }, "ses-prior-spend")
		mock.timers.tick(1)
		await settle()
		mock.timers.tick(60_000)
		await settle()
		assert.equal(runsOf({ plugin, calls }, PROMPT).length, 2, "earlier spend in the session is not the loop's")
	} finally {
		mock.timers.reset()
	}
})
