/**
 * Contract: the monitor publishes its watches into the shared background-task
 * registry (`%TEMP%/opencode-background-tasks/state.json`) even when that
 * folder does not exist yet, creating it.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadV2, waitUntil } from "./v2-harness.ts"

test("A watch is published to the shared registry, creating its folder when missing", async () => {
	// The plugin reads TEMP when it loads, so point it at an empty folder first.
	const temp = mkdtempSync(join(tmpdir(), "monitor-registry-"))
	process.env.TEMP = temp
	const registry = join(temp, "opencode-background-tasks", "state.json")
	assert.equal(existsSync(join(temp, "opencode-background-tasks")), false)

	const { default: plugin } = await import("../monitor.ts")
	const h = await loadV2(plugin)
	try {
		const started = await h.run("monitor", { command: "echo REGISTRY_LINE", description: "registry watch" }, "ses_r")
		const id = /Watching \((m[0-9a-f]+)\)/.exec(started)?.[1]
		assert.ok(id, `no watch id in: ${started}`)
		await waitUntil(() => existsSync(registry))
		const { tasks } = JSON.parse(readFileSync(registry, "utf8")) as { tasks: Array<Record<string, unknown>> }
		const row = tasks.find((t) => t.id === id)
		assert.ok(row, `watch ${id} not in ${JSON.stringify(tasks)}`)
		assert.equal(row.sessionID, "ses_r")
		assert.equal(row.description, "[monitor] registry watch")
		assert.equal(row.monitor, true)
	} finally {
		await h.cleanup?.()
	}
})
