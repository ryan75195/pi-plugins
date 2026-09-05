/**
 * goal — opencode plugin
 *
 * Claude Code's /goal for opencode: set a completion condition and the agent
 * keeps working toward it without per-step prompting.
 *
 *   /goal <condition>   (via the /goal command → model calls goal_set)
 *   /goal               → status
 *   /goal clear         → clear
 *
 * How it works (mirrors Claude Code's prompt-based Stop hook):
 *   1. Setting a goal records the condition and the current turn continues.
 *   2. Every time the session goes idle (a turn finished), the plugin sends
 *      the condition plus a capped transcript to a small fast model
 *      (config `small_model`, falling back to the session's own model) via a
 *      throwaway child session.
 *   3. The evaluator replies MET / NOT_MET / IMPOSSIBLE with a reason.
 *      - NOT_MET  → the reason is injected as guidance and a new turn starts.
 *      - MET      → goal cleared, achievement recorded and announced.
 *      - IMPOSSIBLE → goal cleared, failure recorded.
 *   4. Anti-stall: three consecutive turns without tool use pause the loop
 *      until the user prompts again. A deferred evaluation (background work
 *      still running) re-checks when the background task completes.
 *
 * The sidebar (opencode/tui/goal-indicator.tsx) shows the live goal state via
 * a shared state file.
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { mkdir, readFile, writeFile, appendFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const STATE_DIR = join(tmpdir(), "opencode-goal")
const STATE_FILE = join(STATE_DIR, "state.json")
const MAX_CONDITION_CHARS = 4000
const MAX_TRANSCRIPT_CHARS = 10_000
const MAX_NO_TOOL_STREAK = 3
const MAX_IDLE_DEFERRALS = 3
const MAX_TURNS = 40 // hard cap: a goal that never resolves stops after this many evaluated turns

type GoalStatus = "active" | "achieved" | "failed" | "paused"

interface GoalState {
	condition: string
	startedAt: number
	turns: number
	lastReason?: string
	status: GoalStatus
	noToolStreak: number
	idleDeferrals: number
	endedAt?: number
}

const VERDICT_SYSTEM =
	"You are a goal evaluator. You judge whether a working session has satisfied a completion condition. " +
	"Reply with exactly one line starting with MET:, NOT_MET:, or IMPOSSIBLE:, followed by a one-sentence reason. " +
	"Judge only from the evidence in the conversation. Do not run tools."

async function persist(goals: Map<string, GoalState>) {
	try {
		await mkdir(STATE_DIR, { recursive: true })
		// Merge, don't overwrite: multiple opencode processes (separate plugin
		// instances) share this file, so keep goals from other processes.
		let existing: Array<{ sessionID: string } & GoalState> = []
		try {
			const { readFile } = await import("node:fs/promises")
			const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as { goals?: Array<{ sessionID: string } & GoalState> }
			existing = raw.goals ?? []
		} catch {
			// first write
		}
		const merged = new Map(existing.map((g) => [g.sessionID, g]))
		for (const [sessionID, g] of goals) merged.set(sessionID, { sessionID, ...g })
		await writeFile(
			STATE_FILE,
			JSON.stringify({ updatedAt: Date.now(), goals: [...merged.values()] }),
		)
	} catch (err) {
		// Surface persist failures in a debug file so silent breakage is diagnosable.
		try {
			await mkdir(STATE_DIR, { recursive: true })
			await appendFile(join(STATE_DIR, "persist-errors.log"), `${new Date().toISOString()} ${String(err)}\n`)
		} catch {
			// nothing more we can do
		}
	}
}

export const GoalPlugin: Plugin = async ({ client, directory }) => {
	const goals = new Map<string, GoalState>()
	const sessionBusy = new Map<string, boolean>()
	// Last model seen per session, used if small_model isn't configured.
	const sessionModel = new Map<string, { providerID: string; modelID: string }>()
	const evaluating = new Set<string>()

	async function sessionModelFor(sessionID: string): Promise<{ providerID: string; modelID: string } | undefined> {
		// Prefer the configured small model (cheap, fast — like Claude Code's Haiku).
		try {
			const cfg = await client.config.get()
			const small = (cfg.data as { small_model?: string } | undefined)?.small_model
			if (small && small.includes("/")) {
				const [providerID, modelID] = small.split("/", 2)
				return { providerID, modelID }
			}
		} catch {
			// fall through to the session's own model
		}
		return sessionModel.get(sessionID)
	}

	async function transcript(sessionID: string): Promise<string> {
		try {
			const result = await client.session.messages({ path: { id: sessionID }, query: { directory } })
			const rows = (result.data ?? []) as Array<{
				info: { role: string }
				parts: Array<{ type: string; text?: string; state?: { output?: string; input?: Record<string, unknown> } }>
			}>
			const lines: string[] = []
			for (const row of rows.slice(-24)) {
				for (const part of row.parts ?? []) {
					if (part.type === "text" && part.text) lines.push(`${row.info.role}: ${part.text}`)
					else if (part.type === "tool" && part.state?.input) {
						const input = JSON.stringify(part.state.input)
						lines.push(`${row.info.role} tool[${part.state.output ? "done" : "running"}]: ${input.slice(0, 160)}`)
						if (part.state.output) lines.push(`  → ${part.state.output.slice(0, 200)}`)
					}
				}
			}
			const text = lines.join("\n")
			return text.length > MAX_TRANSCRIPT_CHARS ? `[...earlier messages omitted...]\n${text.slice(-MAX_TRANSCRIPT_CHARS)}` : text
		} catch {
			return "(transcript unavailable)"
		}
	}

	function parseVerdict(text: string): { verdict: "MET" | "NOT_MET" | "IMPOSSIBLE"; reason: string } | undefined {
		const m = text.match(/^\s*(MET|NOT_MET|IMPOSSIBLE)\s*[:\-]\s*(.+)$/im)
		if (!m) return undefined
		return { verdict: m[1] as "MET" | "NOT_MET" | "IMPOSSIBLE", reason: m[2].trim().slice(0, 400) }
	}

	async function evaluate(sessionID: string) {
		const goal = goals.get(sessionID)
		if (!goal || goal.status !== "active" || evaluating.has(sessionID)) return
		evaluating.add(sessionID)
		try {
			const model = await sessionModelFor(sessionID)
			const prompt =
				`Completion condition: ${goal.condition}\n\n` +
				`Recent conversation:\n${await transcript(sessionID)}\n\n` +
				`Has the condition been satisfied? Reply with exactly one line: MET: <reason>, NOT_MET: <what is missing>, or IMPOSSIBLE: <why it can never be met>.`

			// Throwaway child session: isolated context, no tools, small model.
			const child = await client.session.create({ body: { title: "goal-eval" }, query: { directory } })
			const childID = child.data?.id
			if (!childID) throw new Error("could not create evaluator session")
			try {
				const result = await client.session.prompt({
					path: { id: childID },
					body: {
						...(model ? { model } : {}),
						system: VERDICT_SYSTEM,
						tools: {},
						parts: [{ type: "text", text: prompt }],
					},
					query: { directory },
				})
				const data = result.data as unknown as { parts?: Array<{ type: string; text?: string }> } | undefined
				let reply = ""
				if (data?.parts) reply = data.parts.filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n")
				let verdict = parseVerdict(reply)
				// Free/small models sometimes return empty; retry once.
				if (!verdict) {
					await new Promise((r) => setTimeout(r, 800))
					const retry = await client.session.prompt({
						path: { id: childID },
						body: {
							...(model ? { model } : {}),
							system: VERDICT_SYSTEM,
							tools: {},
							parts: [{ type: "text", text: "Reply now with exactly one line: MET: <reason>, NOT_MET: <what is missing>, or IMPOSSIBLE: <why>." }],
						},
						query: { directory },
					})
					const retryData = retry.data as unknown as { parts?: Array<{ type: string; text?: string }> } | undefined
					const retryReply = (retryData?.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n")
					verdict = parseVerdict(retryReply)
				}

				if (!verdict) {
					goal.lastReason = `evaluator gave no verdict; continuing (${reply.slice(0, 120)})`
				} else if (verdict.verdict === "MET") {
					goal.status = "achieved"
					goal.lastReason = verdict.reason
					goal.endedAt = Date.now()
					await deliver(sessionID, `◎ Goal achieved in ${goal.turns} turns: ${goal.condition}\nEvaluator: ${verdict.reason}`)
				} else if (verdict.verdict === "IMPOSSIBLE") {
					goal.status = "failed"
					goal.lastReason = verdict.reason
					goal.endedAt = Date.now()
					await deliver(sessionID, `◎ Goal marked impossible by the evaluator — cleared.\nCondition: ${goal.condition}\nReason: ${verdict.reason}`)
				} else {
					goal.turns += 1
					goal.lastReason = verdict.reason
					// Anti-stall: if the last assistant turn used no tools, count it.
					if (await lastTurnHadNoTools(sessionID)) goal.noToolStreak += 1
					else goal.noToolStreak = 0

					if (goal.turns >= MAX_TURNS) {
						goal.status = "failed"
						goal.endedAt = Date.now()
						await deliver(
							sessionID,
							`◎ Goal stopped after ${MAX_TURNS} turns without the condition being met — cleared to avoid burning tokens.\nCondition: ${goal.condition}\nLast evaluation: ${verdict.reason}\nSet a narrower goal or continue manually.`,
						)
					} else if (goal.noToolStreak >= MAX_NO_TOOL_STREAK) {
						goal.status = "paused"
						await deliver(
							sessionID,
							`◎ Goal paused: ${MAX_NO_TOOL_STREAK} turns without tool use, so the loop stopped to avoid spinning.\nCondition: ${goal.condition}\nLast evaluation: ${verdict.reason}\nKeep prompting to resume the loop.`,
						)
					} else {
						await deliver(
							sessionID,
							`◎ Goal evaluation: NOT YET MET (turn ${goal.turns}).\nEvaluator guidance: ${verdict.reason}\nContinue working toward the goal. Condition: ${goal.condition}`,
						)
					}
				}
			} finally {
				await client.session.delete({ path: { id: childID }, query: { directory } }).catch(() => {})
			}
		} catch (err) {
			// Transient evaluator failures keep the goal active (like Claude Code).
			const goal = goals.get(sessionID)
			if (goal) goal.lastReason = `evaluation error: ${String(err).slice(0, 200)}`
		} finally {
			evaluating.delete(sessionID)
			await persist(goals)
		}
	}

	async function lastTurnHadNoTools(sessionID: string): Promise<boolean> {
		try {
			const result = await client.session.messages({ path: { id: sessionID }, query: { directory } })
			const rows = (result.data ?? []) as Array<{ info: { role: string }; parts: Array<{ type: string }> }>
			for (let i = rows.length - 1; i >= 0; i--) {
				const row = rows[i]!
				if (row.info.role !== "assistant") continue
				return !(row.parts ?? []).some((p) => p.type === "tool")
			}
			return false
		} catch {
			return false
		}
	}

	async function deliver(sessionID: string, text: string) {
		// Same mechanism as background-task notifications: prompt_async triggers
		// a new turn. If the user is typing/streaming, skip this push — their
		// own prompt continues the work and the next idle re-evaluates.
		if (sessionBusy.get(sessionID)) return
		try {
			await client.session.promptAsync({
				path: { id: sessionID },
				body: { parts: [{ type: "text", text }] },
				query: { directory },
			})
		} catch {
			// session gone or server shutting down
		}
	}

	async function backgroundWorkRunning(sessionID: string): Promise<boolean> {
		try {
			const { readFile } = await import("node:fs/promises")
			const raw = JSON.parse(
				await readFile(join(tmpdir(), "opencode-background-tasks", "state.json"), "utf8"),
			) as { tasks?: Array<{ sessionID: string; status: string }> }
			return (raw.tasks ?? []).some((t) => t.sessionID === sessionID && t.status === "running")
		} catch {
			return false
		}
	}

	return {
		event: async ({ event }) => {
			if (event.type === "session.status") {
				sessionBusy.set(event.properties.sessionID, event.properties.status.type !== "idle")
				return
			}
			if (event.type === "session.idle") {
				const sessionID = event.properties.sessionID
				sessionBusy.set(sessionID, false)
				const goal = goals.get(sessionID)
				if (!goal || goal.status !== "active" || evaluating.has(sessionID)) return
				// Background work in flight: defer the evaluation (the task
				// completion notification will trigger the next turn anyway).
				if (await backgroundWorkRunning(sessionID)) {
					goal.idleDeferrals += 1
					if (goal.idleDeferrals <= MAX_IDLE_DEFERRALS) return
					// Too many deferrals: evaluate anyway against what's visible.
				}
				goal.idleDeferrals = 0
				void evaluate(sessionID)
				return
			}
			if (event.type === "message.updated") {
				const msg = (event.properties as { info?: { role?: string; sessionID?: string; modelID?: string; providerID?: string } }).info
				if (msg?.role === "assistant" && msg.sessionID && msg.modelID && msg.providerID) {
					sessionModel.set(msg.sessionID, { providerID: msg.providerID, modelID: msg.modelID })
				}
				return
			}
			if (event.type === "session.error") {
				const props = event.properties as unknown as { sessionID?: string; error?: { name?: string } }
				const goal = props.sessionID ? goals.get(props.sessionID) : undefined
				if (!goal || goal.status !== "active") return
				// Unrecoverable classes clear the goal (like Claude Code): auth,
				// credits/balance, model availability. Transient errors don't.
				const name = (props.error?.name ?? "").toLowerCase()
				if (name.includes("auth") || name.includes("credential") || name.includes("balance") || name.includes("usage") || name.includes("model")) {
					goal.status = "failed"
					goal.lastReason = `unrecoverable error: ${name}`
					goal.endedAt = Date.now()
					void persist(goals)
				}
			}
		},

		tool: {
			goal_set: tool({
				description:
					"Set a completion condition for this session. The agent keeps working toward it automatically: after every turn an evaluator model checks the condition and continues the loop until it is met, impossible, or paused for lack of progress. The condition should be verifiable from the conversation (e.g. 'all tests in test/auth pass', 'git status is clean').",
				args: {
					condition: tool.schema.string().describe("The completion condition, verifiable from the conversation. Max 4000 chars."),
				},
				async execute(args, context) {
					if (!args.condition.trim()) throw new Error("Condition must not be empty")
					const goal: GoalState = {
						condition: args.condition.slice(0, MAX_CONDITION_CHARS),
						startedAt: Date.now(),
						turns: 0,
						status: "active",
						noToolStreak: 0,
						idleDeferrals: 0,
					}
					goals.set(context.sessionID, goal)
					await persist(goals)
					return [
						`◎ Goal set (session-scoped). Start working toward it now.`,
						`Condition: ${goal.condition}`,
						`After each of your turns an evaluator checks the condition; if it is not yet met you get guidance and continue. Do not ask the user between turns — keep going until the evaluator reports MET.`,
					].join("\n")
				},
			}),

			goal_status: tool({
				description: "Report the current /goal state for this session: condition, runtime, turns evaluated, last evaluator reason.",
				args: {},
				async execute(_args, context) {
					const goal = goals.get(context.sessionID)
					if (!goal) return "No goal set for this session."
					const runtime = humanDuration((goal.endedAt ?? Date.now()) - goal.startedAt)
					const lines = [
						`◎ Goal ${goal.status}`,
						`Condition: ${goal.condition}`,
						`Running: ${runtime} · turns evaluated: ${goal.turns}`,
					]
					if (goal.lastReason) lines.push(`Last evaluator reason: ${goal.lastReason}`)
					return lines.join("\n")
				},
			}),

			goal_clear: tool({
				description: "Clear the active /goal for this session.",
				args: {},
				async execute(_args, context) {
					const goal = goals.get(context.sessionID)
					if (!goal) return "No goal set."
					goal.status = "paused"
					goal.endedAt = Date.now()
					await persist(goals)
					return `Goal cleared: ${goal.condition}`
				},
			}),
		},
	}
}

function humanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.round((ms % 60_000) / 1000)
	return `${m}m${s}s`
}
