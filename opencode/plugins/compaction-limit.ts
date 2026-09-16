/**
 * compaction-limit — opencode plugin
 *
 * Enforces a per-session context limit read from `session.metadata.compactionLimit`.
 * The app (opencode-ios) writes that key and shows the state; this plugin does the
 * enforcing, because a phone-side watcher cannot act while iOS suspends the app.
 *
 * On every `session.idle` event, for a session that carries a positive
 * `compactionLimit`, the plugin looks at the latest assistant message's
 * `tokens.input + tokens.cache.read + tokens.cache.write`. If that exceeds the
 * limit, the session is not already compacting, and this message id has not
 * already been compacted, it calls `POST /session/{id}/summarize` with that
 * message's `providerID`/`modelID` and `auto: true`, then persists the
 * compacted message id into `session.metadata.compactionLastHead` (merged via
 * PATCH) so a restarted server does not compact the same head again.
 * `session.compacted` clears the in-memory head for that session.
 *
 * The vendored `@opencode-ai/sdk` typings lag the running server: they have no
 * `metadata` on `Session` and no `auto` on the summarize body. Fields the SDK
 * doesn't know about are still sent, cast at the call site, the way
 * remote-control.ts already does for endpoints the SDK lags on.
 */
import type { Plugin } from "@opencode-ai/plugin"
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

export function latestAssistantContext(messages: unknown): AssistantContext | null {
	if (!Array.isArray(messages)) return null
	for (let i = messages.length - 1; i >= 0; i--) {
		const info = (messages[i] as { info?: Record<string, unknown> } | undefined)?.info
		if (!info || info.role !== "assistant") continue
		const { id, providerID, modelID, tokens } = info as {
			id?: unknown
			providerID?: unknown
			modelID?: unknown
			tokens?: { input?: unknown; cache?: { read?: unknown; write?: unknown } }
		}
		if (typeof id !== "string" || typeof providerID !== "string" || typeof modelID !== "string") continue
		if (typeof tokens !== "object" || tokens === null) continue
		const input = typeof tokens.input === "number" ? tokens.input : 0
		const cacheRead = typeof tokens.cache?.read === "number" ? tokens.cache.read : 0
		const cacheWrite = typeof tokens.cache?.write === "number" ? tokens.cache.write : 0
		return { messageID: id, providerID, modelID, context: input + cacheRead + cacheWrite }
	}
	return null
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

export const CompactionLimit: Plugin = async ({ client, directory }) => {
	const lastHeadBySession = new Map<string, string>()
	const pending = new Set<string>()

	async function handleIdle(sessionID: string): Promise<void> {
		if (pending.has(sessionID)) return
		pending.add(sessionID)
		try {
			const sessionResult = await client.session.get({ path: { id: sessionID }, query: { directory } })
			const session = sessionResult.data as
				| { metadata?: unknown; time?: { compacting?: number } }
				| undefined
			if (!session) return
			const limit = readLimit(session.metadata)
			if (limit === undefined) return

			const messagesResult = await client.session.messages({ path: { id: sessionID }, query: { directory } })
			const latest = latestAssistantContext(messagesResult.data)
			const compacting = session.time?.compacting !== undefined
			const lastHead = lastHeadBySession.get(sessionID) ?? readLastHead(session.metadata)

			if (decide({ limit, latest, compacting, lastHead }) !== "compact" || !latest) return

			lastHeadBySession.set(sessionID, latest.messageID)
			try {
				await client.session.summarize({
					path: { id: sessionID },
					body: { providerID: latest.providerID, modelID: latest.modelID, auto: true } as never,
					query: { directory },
				})
				const metadata = typeof session.metadata === "object" && session.metadata !== null ? session.metadata : {}
				await client.session.update({
					path: { id: sessionID },
					body: { metadata: { ...metadata, compactionLastHead: latest.messageID } } as never,
					query: { directory },
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

	return {
		event: async ({ event }) => {
			if (event.type === "session.idle") {
				void handleIdle(event.properties.sessionID)
				return
			}
			if (event.type === "session.compacted") {
				lastHeadBySession.delete(event.properties.sessionID)
			}
		},
	}
}

const compactionLimitEntry: Plugin = async (input, options) => {
	try {
		return await CompactionLimit(input, options)
	} catch {
		return {}
	}
}

export default compactionLimitEntry
