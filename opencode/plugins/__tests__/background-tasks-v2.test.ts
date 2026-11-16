/**
 * Contract: the background-tasks plugin, on the opencode 2.3 (V2) API, loads
 * as a default `Plugin.define` export, registers its tools once, adds its
 * guidance to the system prompt once, and wakes the task's session with a
 * queued synthetic notice when a background task finishes.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import plugin from "../background-tasks.ts"
import { loadV2, waitUntil } from "./v2-harness.ts"

const TOOLS = ["bash", "bash_background", "task_output", "task_stop", "task_list"]

test("The plugin is a V2 definition with a stable id", () => {
	assert.equal(plugin.id, "background-tasks")
	assert.equal(typeof plugin.setup, "function")
})

test("The plugin registers each of its tools exactly once", async () => {
	const h = await loadV2(plugin)
	try {
		assert.deepEqual([...h.added].sort(), [...TOOLS].sort())
	} finally {
		await h.cleanup?.()
	}
})

test("Its bash replaces opencode's own shell tool, leaving the model one shell tool", async () => {
	const shell = { name: "shell", description: "built-in", input: {}, options: { codemode: false }, execute: async () => ({ content: "BUILT_IN" }) }
	const h = await loadV2(plugin, process.cwd(), [shell])
	try {
		assert.deepEqual([...h.tools.keys()].sort(), [...TOOLS].sort())
		// Top-level like the built-in it replaces, not tucked inside code mode.
		assert.equal(h.tools.get("bash")?.options?.codemode, false)
		assert.equal((await h.run("bash", { command: "echo PLUGIN_SHELL" }, "ses_s")).trim(), "PLUGIN_SHELL")
	} finally {
		await h.cleanup?.()
	}
})

test("The guidance reaches the system prompt once, however often the hook runs", async () => {
	const h = await loadV2(plugin)
	try {
		const once = await h.context(["base"])
		assert.equal(once.length, 2)
		assert.match(once[1], /^Background tasks \(plugin primitive\)/)
		const twice = await h.context(once)
		assert.deepEqual(twice, once)
	} finally {
		await h.cleanup?.()
	}
})

test("A finished background task wakes its session with a queued notice carrying its output", async () => {
	const h = await loadV2(plugin)
	try {
		const started = await h.run("bash_background", { command: "echo NOTICE_PAYLOAD", description: "probe" }, "ses_a")
		const id = /Started background task (\w+)/.exec(started)?.[1]
		assert.ok(id, `no task id in: ${started}`)
		await waitUntil(() => h.synthetic.length > 0)
		const [notice] = h.synthetic
		assert.equal(notice.sessionID, "ses_a")
		assert.equal(notice.delivery, "queue")
		assert.equal(notice.resume, true)
		assert.deepEqual(notice.metadata, { source: "plugin" })
		assert.match(notice.text, new RegExp(`^Background task ${id} ✔ completed \\(exit code 0, `))
		assert.match(notice.text, /"probe" \(echo NOTICE_PAYLOAD\)/)
		assert.match(notice.text, /Last output:\n[\s\S]*NOTICE_PAYLOAD/)
	} finally {
		await h.cleanup?.()
	}
})

test("A foreground bash command returns its output and sends no notice", async () => {
	const h = await loadV2(plugin)
	try {
		const out = await h.run("bash", { command: "echo FOREGROUND_OK" }, "ses_b")
		assert.equal(out.trim(), "FOREGROUND_OK")
		await new Promise((resolve) => setTimeout(resolve, 200))
		assert.equal(h.synthetic.length, 0)
	} finally {
		await h.cleanup?.()
	}
})

test("Asking for an unknown task fails with a message that points at task_list", async () => {
	const h = await loadV2(plugin)
	try {
		await assert.rejects(h.run("task_output", { task_id: "nope" }, "ses_c"), /Unknown task ID: nope\. Use task_list to see known tasks\./)
		await assert.rejects(h.run("task_stop", { task_id: "nope" }, "ses_c"), /Unknown task ID: nope/)
	} finally {
		await h.cleanup?.()
	}
})
