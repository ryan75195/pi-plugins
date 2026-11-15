import { test } from "node:test"
import assert from "node:assert/strict"
import CompactionLimit, { readLimit, latestAssistantContext, decide, type AssistantContext } from "../compaction-limit.ts"

const OVER = { input: 150_000, output: 0, reasoning: 0, cache: { read: 60_000, write: 0 } }
const UNDER = { input: 50_000, output: 0, reasoning: 0, cache: { read: 10_000, write: 0 } }

/** A V2 assistant message: flat, with `type` and a `model` ref instead of V1's `info.role`/`providerID`/`modelID`. */
function assistantMsg(overrides: Record<string, unknown> = {}) {
	return {
		id: "m1",
		type: "assistant",
		model: { id: "claude-sonnet", providerID: "anthropic" },
		time: { created: 0 },
		content: [],
		tokens: { input: 100, output: 10, reasoning: 0, cache: { read: 0, write: 0 } },
		...overrides,
	}
}

function userMsg(text = "hi") {
	return { id: "u1", type: "user", text, time: { created: 0 } }
}

async function flush(turns = 15): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

type FakeEvent = { type: string; data: { sessionID: string } }

/** A pushable async stream standing in for `ctx.event.subscribe()`. */
function eventStream() {
	const queue: FakeEvent[] = []
	let wake: (() => void) | undefined
	let closed = false
	const subscriptions: Array<{ types?: readonly string[] }> = []
	return {
		subscriptions,
		push(event: FakeEvent) {
			queue.push(event)
			wake?.()
		},
		close() {
			closed = true
			wake?.()
		},
		subscribe(options?: { types?: readonly string[]; signal?: AbortSignal }) {
			subscriptions.push({ types: options?.types })
			options?.signal?.addEventListener("abort", () => {
				closed = true
				wake?.()
			})
			return (async function* () {
				while (true) {
					while (queue.length > 0) {
						const event = queue.shift()!
						if (!options?.types || options.types.includes(event.type)) yield event
					}
					if (closed) return
					await new Promise<void>((resolve) => (wake = resolve))
					wake = undefined
				}
			})()
		},
	}
}

function makeServer(initial: {
	metadata?: Record<string, unknown>
	messages?: unknown[]
	compactError?: Error
} = {}) {
	let metadata: Record<string, unknown> | undefined = initial.metadata
	let messages = initial.messages ?? []
	const compactCalls: Array<{ sessionID: string }> = []
	const updateCalls: Array<{ sessionID: string; metadata?: Record<string, unknown> }> = []
	const events = eventStream()

	return {
		events,
		compactCalls,
		updateCalls,
		setMessages: (m: unknown[]) => {
			messages = m
		},
		setMetadata: (m: Record<string, unknown>) => {
			metadata = m
		},
		session: {
			get: async ({ sessionID }: { sessionID: string }) => ({ id: sessionID, metadata, time: { created: 0, updated: 0 } }),
			context: async () => messages,
			compact: async (input: { sessionID: string }) => {
				compactCalls.push(input)
				if (initial.compactError) throw initial.compactError
				return { id: "c1", sessionID: input.sessionID, type: "compaction", payload: {}, delivery: "steer" }
			},
			update: async (input: { sessionID: string; metadata?: Record<string, unknown> }) => {
				updateCalls.push(input)
				metadata = input.metadata
			},
		},
	}
}

type IdleHook = (input: { sessionID: string; background: unknown[] }) => void | Promise<void>

/** Runs the real plugin's setup against a fake V2 context and hands back its idle hook. */
async function start(server: ReturnType<typeof makeServer>) {
	const hooks = new Map<string, IdleHook>()
	const ctx = {
		session: {
			...server.session,
			hook: async (name: string, callback: IdleHook) => {
				hooks.set(name, callback)
				return { dispose: async () => {} }
			},
		},
		event: { subscribe: server.events.subscribe },
	}
	const cleanup = await CompactionLimit.setup(ctx as never)
	const idle = hooks.get("experimental.idle")
	assert.ok(idle, "the plugin registers an experimental.idle hook")
	return {
		hooks,
		cleanup,
		async fireIdle(sessionID: string) {
			await idle({ sessionID, background: [] })
			await flush()
		},
		async fireEvent(type: string, sessionID: string) {
			server.events.push({ type, data: { sessionID } })
			await flush()
		},
	}
}

test("the default export is a V2 plugin definition", () => {
	assert.equal(CompactionLimit.id, "compaction-limit")
	assert.equal(typeof CompactionLimit.setup, "function")
})

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
	const msgs = [userMsg("first"), assistantMsg({ id: "m1", tokens: UNDER }), userMsg("second"), assistantMsg({ id: "m2", tokens: OVER })]
	const result = latestAssistantContext(msgs)
	assert.deepEqual(result, { messageID: "m2", providerID: "anthropic", modelID: "claude-sonnet", context: 210_000 })
})

test("latestAssistantContext: a trailing user or idle message does not hide the latest assistant message", () => {
	const msgs = [assistantMsg({ id: "m1", tokens: OVER }), userMsg("still thinking"), { id: "i1", type: "idle" }]
	assert.equal(latestAssistantContext(msgs)?.messageID, "m1")
})

test("latestAssistantContext: no assistant message returns null", () => {
	assert.equal(latestAssistantContext([userMsg()]), null)
	assert.equal(latestAssistantContext([]), null)
})

test("latestAssistantContext: an assistant message without tokens is skipped", () => {
	const msgs = [assistantMsg({ id: "m1", tokens: OVER }), assistantMsg({ id: "m2", tokens: undefined })]
	assert.equal(latestAssistantContext(msgs)?.messageID, "m1")
})

test("latestAssistantContext: context sums input, cache.read and cache.write", () => {
	const msgs = [assistantMsg({ id: "m1", tokens: { input: 10, output: 999, reasoning: 999, cache: { read: 20, write: 30 } } })]
	assert.equal(latestAssistantContext(msgs)?.context, 60)
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
	const server = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [userMsg(), assistantMsg({ id: "m1", tokens: OVER })] })
	const plugin = await start(server)

	await plugin.fireIdle("s1")
	assert.deepEqual(server.compactCalls, [{ sessionID: "s1" }])
	assert.equal(server.updateCalls.length, 1)
	assert.equal(server.updateCalls[0]?.sessionID, "s1")
	assert.equal(server.updateCalls[0]?.metadata?.compactionLastHead, "m1")

	await plugin.fireIdle("s1")
	assert.equal(server.compactCalls.length, 1, "a second idle for the same head does not compact again")

	server.setMessages([userMsg(), assistantMsg({ id: "m1", tokens: OVER }), userMsg(), assistantMsg({ id: "m2", tokens: OVER })])
	await plugin.fireIdle("s1")
	assert.equal(server.compactCalls.length, 2, "a later assistant message over the limit triggers a new compaction")
	assert.equal(server.updateCalls[1]?.metadata?.compactionLastHead, "m2")
	assert.equal(server.updateCalls[1]?.metadata?.compactionLimit, 200_000, "the existing metadata is merged, not replaced")
})

test("under the limit, unmetered, or assistant-less sessions are never compacted", async () => {
	const underLimit = makeServer({ metadata: { compactionLimit: 300_000 }, messages: [assistantMsg({ id: "m1", tokens: OVER })] })
	await (await start(underLimit)).fireIdle("s-under")
	assert.equal(underLimit.compactCalls.length, 0, "over 200000 but under this session's 300000 limit is left alone")

	const noMetadata = makeServer({ messages: [assistantMsg({ id: "m1", tokens: OVER })] })
	await (await start(noMetadata)).fireIdle("s-nokey")
	assert.equal(noMetadata.compactCalls.length, 0, "a session with no compactionLimit key is never touched")

	const noAssistant = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [userMsg()] })
	await (await start(noAssistant)).fireIdle("s-none")
	assert.equal(noAssistant.compactCalls.length, 0, "a session with no assistant message is left alone")
})

test("a session whose compaction is still running is left alone", async () => {
	const runningMessage = makeServer({
		metadata: { compactionLimit: 200_000 },
		messages: [assistantMsg({ id: "m1", tokens: OVER }), { id: "c0", type: "compaction", status: "running", reason: "auto", summary: "" }],
	})
	await (await start(runningMessage)).fireIdle("s-busy")
	assert.equal(runningMessage.compactCalls.length, 0, "a running compaction message in the context means busy")

	const startedEvent = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [assistantMsg({ id: "m1", tokens: OVER })] })
	const plugin = await start(startedEvent)
	await plugin.fireEvent("session.compaction.started", "s-busy")
	await plugin.fireIdle("s-busy")
	assert.equal(startedEvent.compactCalls.length, 0, "a session.compaction.started without its end means busy")

	await plugin.fireEvent("session.compaction.failed", "s-busy")
	await plugin.fireIdle("s-busy")
	assert.equal(startedEvent.compactCalls.length, 1, "a failed compaction is no longer busy")
})

test("the plugin subscribes only to the compaction events and stops on cleanup", async () => {
	const server = makeServer()
	const plugin = await start(server)
	assert.deepEqual(server.events.subscriptions, [
		{ types: ["session.compaction.started", "session.compaction.ended", "session.compaction.failed"] },
	])
	assert.equal(typeof plugin.cleanup, "function")
	await (plugin.cleanup as () => Promise<void> | void)()
	await flush()
})

test("a failed compact call is logged once per head and retried only for a later head", async () => {
	const server = makeServer({
		metadata: { compactionLimit: 200_000 },
		messages: [assistantMsg({ id: "m1", tokens: OVER })],
		compactError: new Error("compact unavailable"),
	})
	const plugin = await start(server)

	await plugin.fireIdle("s1")
	assert.equal(server.compactCalls.length, 1)
	assert.equal(server.updateCalls.length, 0, "a failed compact call is never persisted as compacted")

	await plugin.fireIdle("s1")
	assert.equal(server.compactCalls.length, 1, "the same head is not retried after a failure")

	server.setMessages([assistantMsg({ id: "m1", tokens: OVER }), assistantMsg({ id: "m2", tokens: OVER })])
	await plugin.fireIdle("s1")
	assert.equal(server.compactCalls.length, 2, "a later assistant message over the limit is retried")
})

test("session.compaction.ended clears the in-memory head so a fresh compaction can happen", async () => {
	const server = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [assistantMsg({ id: "m1", tokens: OVER })] })
	const plugin = await start(server)

	await plugin.fireIdle("s1")
	assert.equal(server.compactCalls.length, 1)

	await plugin.fireEvent("session.compaction.ended", "s1")
	server.setMetadata({ compactionLimit: 200_000 })

	await plugin.fireIdle("s1")
	assert.equal(server.compactCalls.length, 2, "clearing the in-memory head after the compaction ends allows the same head id to compact again once the server's own record is gone")
})

test("a persisted compactionLastHead survives a restart and is not recompacted", async () => {
	const server = makeServer({ metadata: { compactionLimit: 200_000 }, messages: [assistantMsg({ id: "m1", tokens: OVER })] })
	await (await start(server)).fireIdle("s1")
	assert.equal(server.compactCalls.length, 1)

	await (await start(server)).fireIdle("s1")
	assert.equal(server.compactCalls.length, 1, "a fresh plugin instance reads compactionLastHead from persisted metadata and does not recompact")
})
