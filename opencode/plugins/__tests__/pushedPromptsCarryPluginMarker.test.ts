/**
 * Contract: a prompt the plugin pushes into a session carries a marker on the
 * part it sends through the session prompt API, so a client can tell it apart
 * from something the user typed. Asserted only on the parts captured from a
 * test double of that API, never on plugin source.
 */
import { test, mock } from "node:test"
import assert from "node:assert/strict"
import { makeHarness, settle, runTool } from "./helpers.ts"

const PROMPT = "re-run the smoke checks and report every failure"
const UNTIL = "the smoke checks pass end to end"
const MARKER = { source: "plugin" }

function textPartsOf(calls: any, sessionID: string): Array<any> {
	return calls.dispatchedParts
		.filter((d: any) => d.sessionID === sessionID)
		.flatMap((d: any) => d.parts)
		.filter((p: any) => p?.type === "text")
}

test("A loop's pushed prompt carries the plugin marker on its text part", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m", until: UNTIL }, "ses-marker")
		mock.timers.tick(1)
		await settle()
		const parts = textPartsOf(calls, "ses-marker")
		assert.ok(parts.length > 0, "the loop must push a text part")
		for (const part of parts) {
			assert.deepEqual(part.metadata, MARKER, "the pushed text part must carry the plugin marker")
		}
	} finally {
		mock.timers.reset()
	}
})

test("The pushed prompt text is delivered unchanged alongside the marker", async () => {
	const { plugin, calls } = await makeHarness()
	mock.timers.enable({ apis: ["setTimeout", "setInterval"] })
	try {
		await runTool(plugin, "loop", { prompt: PROMPT, every: "5m", until: UNTIL }, "ses-marker-text")
		mock.timers.tick(1)
		await settle()
		const parts = textPartsOf(calls, "ses-marker-text")
		assert.ok(
			parts.some((part: any) => part.text === PROMPT),
			"the pushed text must still be delivered unchanged",
		)
	} finally {
		mock.timers.reset()
	}
})
