/**
 * compaction-limit — opencode plugin (opencode 2.3.0 / V2 plugin API)
 *
 * Enforces a per-session context limit read from `session.metadata.compactionLimit`.
 * The app (opencode-ios) writes that key and shows the state; this plugin does the
 * enforcing, because a phone-side watcher cannot act while iOS suspends the app.
 *
 * When a session finishes model work and is about to go idle (the
 * `experimental.idle` session hook — V2 has no `session.idle` plugin event), for a
 * session that carries a positive `compactionLimit`, the plugin looks at the
 * latest assistant message's `tokens.input + tokens.cache.read + tokens.cache.write`.
 * If that exceeds the limit, the session is not already compacting, and this
 * message id has not already been compacted, it calls `session.compact` (V2 always
 * compacts with the session's own model and takes no `auto` flag), then persists
 * the compacted message id into `session.metadata.compactionLastHead` (merged with
 * the existing metadata) so a restarted server does not compact the same head again.
 * `session.compaction.ended` (the V2 successor of `session.compacted`) clears the
 * in-memory head for that session.
 */
import { Plugin } from "@opencode/plugin"
import { appendFile, mkdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(tmpdir(), "opencode-compaction-limit")
const LOG_FILE = join(STATE_DIR, "errors.log")

export interface AssistantContext {
	messageID: string
	providerID: string
	modelID: string
	context: number
}

export type CompactionDecision = "compact" | "skip"

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue }

export function readLimit(metadata: unknown): number | undefined {
	if (typeof metadata !== "object" || metadata === null) return undefined
	const limit = (metadata as Record<string, unknown>).compactionLimit
	if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0) return undefined
	return limit
}

function readLastHead(metadata: unknown): string | undefined {
	if (typeof metadata !== "object" || metadata === null) return undefined
	const head = (metadata as Record<string, unknown>).compactionLastHead
	return typeof head === "string" && head.length > 0 ? head : undefined
}

/**
 * V2 messages are flat (`{ id, type: "assistant", model: { id, providerID }, tokens }`)
 * instead of V1's `{ info: { id, role, providerID, modelID, tokens } }`.
 */
export function latestAssistantContext(messages: unknown): AssistantContext | null {
	if (!Array.isArray(messages)) return null
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown> | undefined
		if (!msg || msg.type !== "assistant") continue
		const { id, model, tokens } = msg as {
			id?: unknown
			model?: { id?: unknown; providerID?: unknown }
			tokens?: { input?: unknown; cache?: { read?: unknown; write?: unknown } }
		}
		const providerID = model?.providerID
		const modelID = model?.id
		if (typeof id !== "string" || typeof providerID !== "string" || typeof modelID !== "string") continue
		if (typeof tokens !== "object" || tokens === null) continue
		const input = typeof tokens.input === "number" ? tokens.input : 0
		const cacheRead = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0
		const cacheWrite = typeof tokens.cache?.write === "number" ? tokens.cache.write : 0
		return { messageID: id, providerID, modelID, context: input + cacheRead + cacheWrite }
	}
	return null
}

/** V2 has no `session.time.compacting`: a compaction still running shows as a `compaction` message with status "running". */
function hasRunningCompaction(messages: unknown): boolean {
	if (!Array.isArray(messages)) return false
	return messages.some((m) => {
		const msg = m as Record<string, unknown> | undefined
		return msg?.type === "compaction" && msg.status === "running"
	})
}

export function decide(input: {
	limit: number | undefined
	latest: AssistantContext | null
	compacting: boolean
	lastHead: string | undefined
}): CompactionDecision {
	if (input.limit === undefined) return "skip"
	if (!input.latest) return "skip"
	if (input.compacting) return "skip"
	if (input.lastHead === input.latest.messageID) return "skip"
	if (input.latest.context <= input.limit) return "skip"
	return "compact"
}

async function logFailure(sessionID: string, head: string, err: unknown): Promise<void> {
	try {
		await mkdir(STATE_DIR, { recursive: true })
		await appendFile(
			LOG_FILE,
			`${new Date().toISOString()} session=${sessionID} head=${head} ${String(err).slice(0, 200)}\n`,
		)
	} catch {
		/* diagnostics must never break the plugin */
	}
}

const RESUBSCRIBE_MIN_MS = 250
const RESUBSCRIBE_MAX_MS = 10_000

/**
 * Feeds every event of `subscribe()` to `onEvent` for as long as the plugin is
 * loaded. A stream that ends or throws is reopened after a short backoff
 * (doubling to a cap, reset once events flow again) instead of leaving the
 * plugin deaf for good; aborting `signal` (the plugin's unload) stops it. A
 * failing handler costs that one event, not the subscription.
 */
async function followEvents<E>(
	signal: AbortSignal,
	subscribe: () => AsyncIterable<E>,
	onEvent: (event: E) => void | Promise<void>,
	onError: (error: unknown) => void = () => {},
): Promise<void> {
	let delay = RESUBSCRIBE_MIN_MS
	while (!signal.aborted) {
		try {
			for await (const event of subscribe()) {
				delay = RESUBSCRIBE_MIN_MS
				try {
					await onEvent(event)
				} catch (error) {
					onError(error)
				}
			}
		} catch (error) {
			if (!signal.aborted) onError(error)
		}
		if (signal.aborted) return
		await new Promise<void>((resolve) => {
			const timer = setTimeout(resolve, delay)
			signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
		})
		delay = Math.min(delay * 2, RESUBSCRIBE_MAX_MS)
	}
}

export default Plugin.define({
	id: "compaction-limit",
	async setup(ctx) {
		const lastHeadBySession = new Map<string, string>()
		const compactingSessions = new Set<string>()
		const pending = new Set<string>()

		async function handleIdle(sessionID: string): Promise<void> {
			if (pending.has(sessionID)) return
			pending.add(sessionID)
			try {
				const session = await ctx.session.get({ sessionID })
				if (!session) return
				const limit = readLimit(session.metadata)
				if (limit === undefined) return

				const messages = await ctx.session.context({ sessionID })
				const latest = latestAssistantContext(messages)
				const compacting = compactingSessions.has(sessionID) || hasRunningCompaction(messages)
				const lastHead = lastHeadBySession.get(sessionID) ?? readLastHead(session.metadata)

				if (decide({ limit, latest, compacting, lastHead }) !== "compact" || !latest) return

				lastHeadBySession.set(sessionID, latest.messageID)
				try {
					await ctx.session.compact({ sessionID })
					const metadata: Record<string, JsonValue> =
						typeof session.metadata === "object" && session.metadata !== null ? session.metadata : {}
					await ctx.session.update({
						sessionID,
						metadata: { ...metadata, compactionLastHead: latest.messageID },
					})
				} catch (err) {
					void logFailure(sessionID, latest.messageID, err)
				}
			} catch (err) {
				void logFailure(sessionID, "unknown", err)
			} finally {
				pending.delete(sessionID)
			}
		}

		await ctx.session.hook("experimental.idle", (input) => {
			void handleIdle(input.sessionID)
		})

		const abort = new AbortController()
		void followEvents(
			abort.signal,
			() =>
				ctx.event.subscribe({
					types: ["session.compaction.started", "session.compaction.ended", "session.compaction.failed"],
					signal: abort.signal,
				}),
			(event) => {
				if (event.type === "session.compaction.started") {
					compactingSessions.add(event.data.sessionID)
				} else if (event.type === "session.compaction.ended") {
					compactingSessions.delete(event.data.sessionID)
					lastHeadBySession.delete(event.data.sessionID)
				} else if (event.type === "session.compaction.failed") {
					compactingSessions.delete(event.data.sessionID)
				}
			},
			(err) => void logFailure("-", "event-stream", err),
		)

		return () => abort.abort()
	},
})
