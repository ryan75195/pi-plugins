/**
 * Contract: the plugin registers the goal and loop tools exactly once each
 * with no name collisions, and its system-prompt guidance covers both the
 * goal and the loop primitives without ever duplicating a section.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { makeHarness } from "./helpers.ts"

const EXPECTED_TOOLS = ["goal_set", "goal_status", "goal_clear", "loop", "loop_stop"]

test("The plugin registers each goal and loop tool exactly once", async () => {
	const { plugin } = await makeHarness()
	const names: string[] = Object.keys(plugin.tool)
	for (const name of EXPECTED_TOOLS) {
		assert.ok(names.includes(name), `expected tool ${name} to be registered`)
	}
	assert.equal(new Set(names).size, names.length, "a tool name is registered more than once")
	for (const name of EXPECTED_TOOLS) {
		assert.equal(typeof plugin.tool[name]?.execute, "function", `tool ${name} has no execute function`)
	}
})

test("The system prompt guidance covers the goal and loop primitives", async () => {
	const { plugin } = await makeHarness()
	const output: { system: string[] } = { system: [] }
	await plugin["experimental.chat.system.transform"]({}, output)
	const joined = output.system.join("\n")
	assert.ok(joined.includes("goal_set"), "the guidance does not cover the goal primitive")
	assert.match(joined, /\bloop\b/, "the guidance does not cover the loop primitive")
	assert.ok(joined.includes("loop_stop"), "the guidance does not cover stopping a loop")
})

test("Repeated system prompt transforms do not duplicate the guidance", async () => {
	const { plugin } = await makeHarness()
	const output: { system: string[] } = { system: [] }
	await plugin["experimental.chat.system.transform"]({}, output)
	const countOf = (text: string, needle: string) => text.split(needle).length - 1
	const goalSections = countOf(output.system.join("\n"), "Goal (plugin primitive)")
	const loopMentions = countOf(output.system.join("\n"), "loop_stop")
	await plugin["experimental.chat.system.transform"]({}, output)
	const joined = output.system.join("\n")
	assert.equal(countOf(joined, "Goal (plugin primitive)"), goalSections, "the goal guidance section is duplicated")
	assert.equal(countOf(joined, "loop_stop"), loopMentions, "the loop guidance is duplicated")
})
