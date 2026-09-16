import { test } from "node:test"
import assert from "node:assert/strict"
import CompactionLimitDefault, { CompactionLimit, readLimit, latestAssistantContext, decide, type AssistantContext } from "../compaction-limit.ts"

function assistantRow(overrides: Record<string, unknown> = {}) {
	return {
		info: {
			id: "m1",
			role: "assistant",
			providerID: "anthropic",
			modelID: "claude-sonnet",
			tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
			...overrides,
		},
	}
}

function userRow(text = "hi") {
	return { info: { id: "u1", role: "user" }, parts: [{ type: "text", text }] }
}

const OVER = { input: 150_000, output: 0, reasoning: 0, cache: { read: 60_000, write: 0 } }
const UNDER = { input: 50_000, output: 0, reasoning: 0, cache: { read: 10_000, write: 0 } }

async function flush(turns = 15): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

function makeServer(initial: {
	metadata?: Record<string, unknown>
	compacting?: boolean
	messages?: unknown[]
	summarizeError?: Error
} = {}) {
	let metadata: Record<string, unknown> = initial.metadata ?? {}
	let compacting = initial.compacting ?? false
	let messages = initial.messages ?? []
	const summarizeCalls: Array<{ providerID: string; modelID: string; auto?: boolean }> = []
	const updateCalls: Array<{ metadata?: Record<string, unknown> }> = []

	function client(): any {
		return {
			session: {
				get: async () => ({ data: { metadata, time: compacting ? { created: 0, updated: 0, compacting: Date.now() } : { created: 0, updated: 0 } } }),
				messages: async () => ({ data: messages }),
				summarize: async ({ body }: { body: { providerID: string; modelID: string; auto?: boolean } }) => {
					summarizeCalls.push(body)
					if (initial.summarizeError) throw initial.summarizeError
					return { data: true }
				},
				update: async ({ body }: { body: { metadata?: Record<string, unknown> } }) => {
					updateCalls.push(body)
					metadata = { ...metadata, ...(body.metadata ?? {}) }
					return { data: { metadata } }
				},
			},
		}
	}

	return {
		client,
		summarizeCalls,
		updateCalls,
		setMessages: (m: unknown[]) => {
			messages = m
		},
		setCompacting: (v: boolean) => {
			compacting = v
		},
		setMetadata: (m: Record<string, unknown>) => {
			metadata = m
		},
	}
}

async function fireIdle(plugin: any, sessionID: string): Promise<void> {
	await plugin.event!({ event: { type: "session.idle", properties: { sessionID } } })
	await flush()
}

async function fireCompacted(plugin: any, sessionID: string): Promise<void> {
	await plugin.event!({ event: { type: "session.compacted", properties: { sessionID } } })
	await flush()
}

test("readLimit: missing key means server default", () => {
	assert.equal(readLimit({}), undefined)
	assert.equal(readLimit(undefined), undefined)
	assert.equal(readLimit(null), undefined)
})

test("readLimit: a non-number value means server default", () => {
	assert.equal(readLimit({ compactionLimit: "200000" }), undefined)
})

test("readLimit: zero means server default", () => {
	assert.equal(readLimit({ compactionLimit: 0 }), undefined)
})

test("readLimit: a positive number is the limit", () => {
	assert.equal(readLimit({ compactionLimit: 200_000 }), 200_000)
})

test("latestAssistantContext: ignores user messages and takes the newest assistant", () => {
	const rows = [userRow("first"), assistantRow({ id: "m1", tokens: UNDER }), userRow("second"), assistantRow({ id: "m2", tokens: OVER })]
	const result = latestAssistantContext(rows)
	assert.deepEqual(result, { messageID: "m2", providerID: "anthropic", modelID: "claude-sonnet", context: 210_000 })
})

test("latestAssistantContext: a trailing user message does not hide the latest assistant message", () => {
	const rows = [assistantRow({ id: "m1", tokens: OVER }), userRow("still thinking")]
	const result = latestAssistantContext(rows)
	assert.equal(result?.messageID, "m1")
})

test("latestAssistantContext: no assistant message returns null", () => {
	assert.equal(latestAssistantContext([userRow()]), null)
	assert.equal(latestAssistantContext([]), null)
})

test("latestAssistantContext: context sums input, cache.read and cache.write", () => {
	const rows = [assistantRow({ id: "m1", tokens: { input: 10, output: 999, reasoning: 999, cache: { read: 20, write: 30 } } })]
	assert.equal(latestAssistantContext(rows)?.context, 60)
})

const LATEST: AssistantContext = { messageID: "m1", providerID: "anthropic", modelID: "claude-sonnet", context: 210_000 }

test("decide: under the limit is left alone", () => {
	assert.equal(decide({ limit: 300_000, latest: { ...LATEST, context: 100_000 }, compacting: false, lastHead: undefined }), "skip")
})

test("decide: over the limit and idle compacts", () => {
	assert.equal(decide({ limit: 200_000, latest: LATEST, compacting: false, lastHead: undefined }), "compact")
})

test("decide: over the limit but already compacting is left alone", () => {
	assert.equal(decide({ limit: 200_000, latest: LATEST, compacting: true, lastHead: undefined }), "skip")
})

test("decide: over the limit but already compacted for this head is left alone", () => {
	assert.equal(decide({ limit: 200_000, latest: LATEST, compacting: false, lastHead: "m1" }), "skip")
})

test("decide: no limit is left alone even far over any reasonable size", () => {
	assert.equal(decide({ limit: undefined, latest: LATEST, compacting: false, lastHead: undefined }), "skip")
})

test("decide: no assistant message is left alone", () => {
	assert.equal(decide({ limit: 200_000, latest: null, compacting: false, lastHead: undefined }), "skip")
})

test("compacts once per head, skips repeats, then compacts again for a later head", async () => {
	const server = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [userRow(), assistantRow({ id: "m1", tokens: OVER })] })
	const plugin = await CompactionLimit({ client: server.client(), directory: "/work" } as any)

	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 1)
	assert.deepEqual(server.summarizeCalls[0], { providerID: "anthropic", modelID: "claude-sonnet", auto: true })
	assert.equal(server.updateCalls.length, 1)
	assert.equal(server.updateCalls[0]?.metadata?.compactionLastHead, "m1")

	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 1, "a second idle event for the same head does not summarize again")

	server.setMessages([userRow(), assistantRow({ id: "m1", tokens: OVER }), userRow(), assistantRow({ id: "m2", tokens: OVER })])
	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 2, "a later assistant message over the limit triggers a new summarize call")
	assert.equal(server.updateCalls[1]?.metadata?.compactionLastHead, "m2")
	assert.equal(server.updateCalls[1]?.metadata?.compactionLimit, 200_000, "the existing metadata is merged, not replaced")
})

test("under the limit, busy, or unmetered sessions are never summarized", async () => {
	const underLimit = makeServer({ metadata: { compactionLimit: 300_000 }, messages: [assistantRow({ id: "m1", tokens: OVER })] })
	const pluginA = await CompactionLimit({ client: underLimit.client(), directory: "/work" } as any)
	await fireIdle(pluginA, "s-under")
	assert.equal(underLimit.summarizeCalls.length, 0, "over 200000 but under this session's 300000 limit is left alone")

	const noMetadata = makeServer({ metadata: {}, messages: [assistantRow({ id: "m1", tokens: OVER })] })
	const pluginB = await CompactionLimit({ client: noMetadata.client(), directory: "/work" } as any)
	await fireIdle(pluginB, "s-nokey")
	assert.equal(noMetadata.summarizeCalls.length, 0, "a session with no compactionLimit key is never touched")

	const busy = makeServer({ metadata: { compactionLimit: 200_000 }, compacting: true, messages: [assistantRow({ id: "m1", tokens: OVER })] })
	const pluginC = await CompactionLimit({ client: busy.client(), directory: "/work" } as any)
	await fireIdle(pluginC, "s-busy")
	assert.equal(busy.summarizeCalls.length, 0, "a session already compacting is left alone")

	const noAssistant = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [userRow()] })
	const pluginD = await CompactionLimit({ client: noAssistant.client(), directory: "/work" } as any)
	await fireIdle(pluginD, "s-none")
	assert.equal(noAssistant.summarizeCalls.length, 0, "a session with no assistant message is left alone")
})

test("a failed summarize call is logged once per head and retried only for a later head", async () => {
	const server = makeServer({
		metadata: { compactionLimit: 200_000 },
		messages: [assistantRow({ id: "m1", tokens: OVER })],
		summarizeError: new Error("summarize unavailable"),
	})
	const plugin = await CompactionLimit({ client: server.client(), directory: "/work" } as any)

	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 1)
	assert.equal(server.updateCalls.length, 0, "a failed summarize call is never persisted as compacted")

	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 1, "the same head is not retried after a failure")

	server.setMessages([assistantRow({ id: "m1", tokens: OVER }), assistantRow({ id: "m2", tokens: OVER })])
	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 2, "a later assistant message over the limit is retried")
})

test("session.compacted clears the pending head so a fresh compaction can happen", async () => {
	const server = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [assistantRow({ id: "m1", tokens: OVER })] })
	const plugin = await CompactionLimit({ client: server.client(), directory: "/work" } as any)

	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 1)

	await fireCompacted(plugin, "s1")
	server.setMetadata({ compactionLimit: 200_000 })

	await fireIdle(plugin, "s1")
	assert.equal(server.summarizeCalls.length, 2, "clearing the in-memory head after session.compacted allows the same head id to compact again once the server's own record is gone")
})

test("a persisted compactionLastHead survives a restart and is not recompacted", async () => {
	const server = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [assistantRow({ id: "m1", tokens: OVER })] })
	const pluginBeforeRestart = await CompactionLimit({ client: server.client(), directory: "/work" } as any)
	await fireIdle(pluginBeforeRestart, "s1")
	assert.equal(server.summarizeCalls.length, 1)

	const pluginAfterRestart = await CompactionLimit({ client: server.client(), directory: "/work" } as any)
	await fireIdle(pluginAfterRestart, "s1")
	assert.equal(server.summarizeCalls.length, 1, "a fresh plugin instance reads compactionLastHead from persisted metadata and does not recompact")
})

test("the default export never throws even when called with an unrelated shape", async () => {
	await assert.doesNotReject(async () => {
		const result = await CompactionLimitDefault({} as any)
		assert.equal(typeof result, "object")
	})
})

const FAKE_PLUGIN_INPUT = { client: {} as any, directory: "/work" }

test("readLimit resolves to {} when the loader calls it as a plugin factory", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (readLimit as any)(FAKE_PLUGIN_INPUT), {})
	})
})

test("readLimit resolves to {} when called with a second options argument", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (readLimit as any)({ compactionLimit: 200_000 }, {}), {})
	})
})

test("latestAssistantContext resolves to {} when the loader calls it as a plugin factory", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (latestAssistantContext as any)(FAKE_PLUGIN_INPUT), {})
	})
})

test("latestAssistantContext resolves to {} when called with a second options argument", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (latestAssistantContext as any)([assistantRow()], {}), {})
	})
})

test("decide resolves to {} when the loader calls it as a plugin factory", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (decide as any)(FAKE_PLUGIN_INPUT), {})
	})
})

test("decide resolves to {} when called with a second options argument", async () => {
	await assert.doesNotReject(async () => {
		assert.deepEqual(await (decide as any)({ limit: 1, latest: null, compacting: false, lastHead: undefined }, {}), {})
	})
})
