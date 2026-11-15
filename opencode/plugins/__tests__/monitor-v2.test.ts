/**
 * Contract: the monitor plugin, on the opencode 2.3 (V2) API, loads as a
 * default `Plugin.define` export, registers monitor and monitor_stop once,
 * adds its guidance once, streams a watch's lines into the session as queued
 * synthetic messages that wake it, and ends a session's watches when the
 * session is deleted.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import plugin from "../monitor.ts"
import { loadV2, waitUntil } from "./v2-harness.ts"

test("The plugin is a V2 definition with a stable id", () => {
	assert.equal(plugin.id, "monitor")
	assert.equal(typeof plugin.setup, "function")
})

test("The plugin registers monitor and monitor_stop exactly once each", async () => {
	const h = await loadV2(plugin)
	try {
		assert.deepEqual([...h.added].sort(), ["monitor", "monitor_stop"])
	} finally {
		await h.cleanup?.()
	}
})

test("The guidance reaches the system prompt once, however often the hook runs", async () => {
	const h = await loadV2(plugin)
	try {
		const once = await h.context(["base"])
		assert.equal(once.length, 2)
		assert.match(once[1], /^Monitor \(plugin primitive\)/)
		assert.deepEqual(await h.context(once), once)
	} finally {
		await h.cleanup?.()
	}
})

test("A watched command's output wakes its session as a queued [monitor] message", async () => {
	const h = await loadV2(plugin)
	try {
		const started = await h.run("monitor", { command: "echo WATCHED_LINE", description: "probe watch" }, "ses_m")
		const id = /Watching \((m[0-9a-f]+)\)/.exec(started)?.[1]
		assert.ok(id, `no watch id in: ${started}`)
		await waitUntil(() => h.synthetic.some((s) => s.text.includes("WATCHED_LINE")))
		const notice = h.synthetic.find((s) => s.text.includes("WATCHED_LINE"))!
		assert.equal(notice.sessionID, "ses_m")
		assert.equal(notice.delivery, "queue")
		assert.equal(notice.resume, true)
		assert.deepEqual(notice.metadata, { source: "plugin" })
		assert.ok(notice.text.startsWith(`[monitor ${id} probe watch`), notice.text)
	} finally {
		await h.cleanup?.()
	}
})

test("Stopping an unknown watch names the active ones", async () => {
	const h = await loadV2(plugin)
	try {
		assert.equal(await h.run("monitor_stop", { id: "mnope" }, "ses_s"), "no active watch 'mnope' (active: none)")
		assert.equal(await h.run("monitor_stop", {}, "ses_s"), "no active watches")
	} finally {
		await h.cleanup?.()
	}
})

test("Deleting a session ends its watches", async () => {
	const h = await loadV2(plugin)
	try {
		const command = process.platform === "win32" ? "ping -n 30 127.0.0.1 >nul" : "sleep 30"
		const started = await h.run("monitor", { command, description: "long watch", persistent: true }, "ses_d")
		const id = /Watching \((m[0-9a-f]+)\)/.exec(started)?.[1]
		h.emit({ type: "session.deleted", data: { sessionID: "ses_d" } })
		await waitUntil(() => h.synthetic.some((s) => s.text === `[monitor ${id} long watch ended: session ended]`))
		assert.equal(await h.run("monitor_stop", { id }, "ses_x"), `no active watch '${id}' (active: none)`)
	} finally {
		await h.cleanup?.()
	}
})
