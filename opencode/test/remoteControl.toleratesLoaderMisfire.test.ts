/**
 * Contract: opencode's local-plugin loader invokes every exported function of a
 * plugin file as a plugin factory, fn(pluginInput, options), not only the file's
 * designated Plugin export. Every non-Plugin export here must resolve to an
 * empty hooks object instead of running its real logic or throwing when called
 * that way.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { updateRegistrations, makeInstanceRouteHandler, openInstanceEventStream, forwardInstanceEvent } from "../plugins/remote-control.ts"

const FAKE_PLUGIN_INPUT = { client: {} as unknown, directory: "/work" }

test("updateRegistrations resolves to {} when the loader calls it as a plugin factory", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (updateRegistrations as any)(FAKE_PLUGIN_INPUT), {})
	})
})

test("updateRegistrations resolves to {} when called with a second options argument", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (updateRegistrations as any)((regs: unknown[]) => regs, {}), {})
	})
})

test("makeInstanceRouteHandler resolves to {} when the loader calls it with a second options argument", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (makeInstanceRouteHandler as any)(FAKE_PLUGIN_INPUT, {}), {})
	})
})

test("openInstanceEventStream resolves to {} when the loader calls it as a plugin factory", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (openInstanceEventStream as any)(FAKE_PLUGIN_INPUT), {})
	})
})

test("openInstanceEventStream resolves to {} when called with a second options argument", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (openInstanceEventStream as any)("/work/some-dir", {}), {})
	})
})

test("forwardInstanceEvent resolves to {} when the loader calls it as a plugin factory", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (forwardInstanceEvent as any)(FAKE_PLUGIN_INPUT, {}), {})
	})
})
