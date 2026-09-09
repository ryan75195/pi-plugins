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
 * The same machinery also hosts the loop primitive (the /loop tool): a prompt
 * re-run on a fixed cadence or self-paced, with an optional until stop
 * condition judged by the same evaluator and an iteration cap.
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
const LOOP_DEFAULT_INTERVAL_MS = 5 * 60_000 // self-paced default: re-run five minutes after each turn
const LOOP_MIN_INTERVAL_MS = 60_000 // token-safety floor for fixed cadences (no sub-minute loops)
const LOOP_MAX_ITERATIONS = 40 // default cap: a loop that never stops ends after this many runs

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

type LoopStatus = "active" | "finished" | "stopped" | "failed"

interface LoopState {
	prompt: string
	until?: string
	/** Fixed cadence in ms; undefined = self-paced (re-run five minutes after each turn). */
	intervalMs?: number
	/** Iterations dispatched so far (the first run at start counts). */
	iterations: number
	maxIterations: number
	status: LoopStatus
	startedAt: number
	endedAt?: number
	lastReason?: string
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

const GOAL_SYSTEM_PROMPT = `Goal (plugin primitive)
When the user states a completion condition - "keep going until the tests pass", "don't stop until the build is green", or the \`/goal\` command - your FIRST tool call is \`goal_set\` with that condition, before any other work. From then on an evaluator checks the condition after each of your turns and either clears the goal (MET) or hands back guidance and starts another turn automatically. So keep working until the evaluator reports MET: do not stop between turns to ask the user whether to carry on. \`goal_status\` reports the active condition and progress, \`goal_clear\` ends it.

Loop (plugin primitive)
When the user wants a prompt re-run on a schedule or over and over - "check the deploy every 5 minutes", "keep running this until it passes", or the \`/loop\` command - your FIRST tool call is \`loop\` with the user's words as \`prompt\` (plus \`every\` for a fixed cadence, \`until\` for the stop condition, \`max_iterations\` for the cap), before any other work. Each iteration is dispatched into the session automatically; keep answering the re-run prompt without asking the user between iterations. \`loop_stop\` ends the active loop early; otherwise the loop ends when the \`until\` condition holds or the iteration cap is reached.`

export const GoalPlugin: Plugin = async ({ client, directory }) => {
	const goals = new Map<string, GoalState>()
	const loops = new Map<string, LoopState>()
	// One pending cadence timer per session with an active loop; dispose() clears them all.
	const loopTimers = new Map<string, ReturnType<typeof setTimeout>>()
	const sessionBusy = new Map<string, boolean>()
	// Last model seen per session, used if small_model isn't configured.
	const sessionModel = new Map<string, { providerID: string; modelID: string }>()
	const evaluating = new Set<string>()
	const loopEvaluating = new Set<string>()

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

	function replyText(data: unknown): string {
		const d = data as { parts?: Array<{ type: string; text?: string }> } | undefined
		return (d?.parts ?? []).filter((p) => p.type === "text" && p.text).map((p) => p.text).join("\n")
	}

	/**
	 * Ask the evaluator (throwaway child session, no tools, small model) to
	 * judge a condition against the session transcript. Shared by the goal
	 * and loop paths. Returns the parsed verdict, or undefined when the model
	 * gave no verdict (after one retry).
	 */
	async function askEvaluator(
		sessionID: string,
		prompt: string,
		title: string,
	): Promise<{ verdict: { verdict: "MET" | "NOT_MET" | "IMPOSSIBLE"; reason: string } | undefined; reply: string }> {
		const model = await sessionModelFor(sessionID)
		const body = {
			...(model ? { model } : {}),
			system: VERDICT_SYSTEM,
			tools: {},
			parts: [{ type: "text" as const, text: prompt }],
		}
		// Throwaway child session: isolated context, no tools, small model.
		const child = await client.session.create({ body: { title }, query: { directory } })
		const childID = child.data?.id
		if (!childID) throw new Error("could not create evaluator session")
		try {
			const result = await client.session.prompt({ path: { id: childID }, body, query: { directory } })
			const reply = replyText(result.data)
			let verdict = parseVerdict(reply)
			// Free/small models sometimes return empty; retry once.
			if (!verdict) {
				await new Promise((r) => setTimeout(r, 800))
				const retry = await client.session.prompt({
					path: { id: childID },
					body: {
						...body,
						parts: [{ type: "text", text: "Reply now with exactly one line: MET: <reason>, NOT_MET: <what is missing>, or IMPOSSIBLE: <why>." }],
					},
					query: { directory },
				})
				verdict = parseVerdict(replyText(retry.data))
			}
			return { verdict, reply }
		} finally {
			await client.session.delete({ path: { id: childID }, query: { directory } }).catch(() => {})
		}
	}

	async function evaluate(sessionID: string) {
		const goal = goals.get(sessionID)
		if (!goal || goal.status !== "active" || evaluating.has(sessionID)) return
		evaluating.add(sessionID)
		try {
			const prompt =
				`Completion condition: ${goal.condition}\n\n` +
				`Recent conversation:\n${await transcript(sessionID)}\n\n` +
				`Has the condition been satisfied? Reply with exactly one line: MET: <reason>, NOT_MET: <what is missing>, or IMPOSSIBLE: <why it can never be met>.`
			const { verdict, reply } = await askEvaluator(sessionID, prompt, "goal-eval")

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

	// ---------------------------------------------------------------------------
	// Loop machinery (the /loop primitive): a prompt re-run on a fixed cadence or
	// self-paced, with an optional until stop condition judged by the same
	// evaluator the goal uses, and an iteration cap. Terminal states end
	// silently — a finished, stopped, or failed loop never starts another turn.
	// ---------------------------------------------------------------------------

	function clearLoopTimer(sessionID: string) {
		const timer = loopTimers.get(sessionID)
		if (timer) {
			clearTimeout(timer)
			loopTimers.delete(sessionID)
		}
	}

	/** Arm the next cadence run for an active loop (fixed interval or the self-paced default). */
	function scheduleNextRun(sessionID: string) {
		const loop = loops.get(sessionID)
		if (!loop || loop.status !== "active" || loop.iterations >= loop.maxIterations) return
		clearLoopTimer(sessionID)
		const timer = setTimeout(() => {
			loopTimers.delete(sessionID)
			void runLoopIteration(sessionID)
		}, loop.intervalMs ?? LOOP_DEFAULT_INTERVAL_MS)
		loopTimers.set(sessionID, timer)
	}

	/** Push an iteration's prompt into the session. Returns false when the session is gone. */
	async function dispatchPrompt(sessionID: string, text: string): Promise<boolean> {
		try {
			await client.session.promptAsync({
				path: { id: sessionID },
				body: { parts: [{ type: "text", text }] },
				query: { directory },
			})
			return true
		} catch {
			return false
		}
	}

	/** Terminalize a loop: clear its timer, mark it ended, and announce at most once. */
	async function endLoop(sessionID: string, loop: LoopState, status: "finished" | "stopped" | "failed", notice?: string) {
		loop.status = status
		loop.endedAt = Date.now()
		clearLoopTimer(sessionID)
		if (notice) await deliver(sessionID, notice)
	}

	function loopCapNotice(loop: LoopState): string {
		return `◎ Loop finished: ${loop.maxIterations} iterations — stopped to avoid burning tokens.\nPrompt: ${loop.prompt}\nStart a new loop or continue manually.`
	}

	async function runLoopIteration(sessionID: string) {
		const loop = loops.get(sessionID)
		if (!loop || loop.status !== "active") return
		if (sessionBusy.get(sessionID)) {
			// A turn is in flight: don't interrupt it and don't spend an
			// iteration. Fixed cadences retry next interval; self-paced loops
			// reschedule when the turn goes idle.
			if (loop.intervalMs !== undefined) scheduleNextRun(sessionID)
			return
		}
		if (loop.iterations >= loop.maxIterations) {
			// Safety net: the cap was reached between arming and firing.
			await endLoop(sessionID, loop, "finished")
			return
		}
		loop.iterations += 1
		const dispatched = await dispatchPrompt(sessionID, loop.prompt)
		if (!dispatched) {
			// Session gone: end the loop silently.
			await endLoop(sessionID, loop, "stopped")
			return
		}
		if (loop.iterations >= loop.maxIterations) {
			await endLoop(sessionID, loop, "finished", loopCapNotice(loop))
			return
		}
		// Fixed cadences re-arm themselves; self-paced loops wait for the
		// turn's session.idle to schedule the next run.
		if (loop.intervalMs !== undefined) scheduleNextRun(sessionID)
	}

	/** Judge a loop's until stop condition on the same evaluator the goal uses. */
	async function evaluateLoopUntil(sessionID: string) {
		const loop = loops.get(sessionID)
		if (!loop || loop.status !== "active" || !loop.until || loopEvaluating.has(sessionID)) return
		loopEvaluating.add(sessionID)
		try {
			const prompt =
				`Stop condition: ${loop.until}\n\n` +
				`Recent conversation:\n${await transcript(sessionID)}\n\n` +
				`Has the stop condition been satisfied? Reply with exactly one line: MET: <reason>, NOT_MET: <what is missing>, or IMPOSSIBLE: <why it can never be met>.`
			const { verdict } = await askEvaluator(sessionID, prompt, "loop-eval")
			if (!verdict) {
				loop.lastReason = "evaluator gave no verdict; continuing"
				return
			}
			loop.lastReason = verdict.reason
			if (verdict.verdict === "MET") {
				await endLoop(
					sessionID,
					loop,
					"finished",
					`◎ Loop finished: the stop condition holds.\nStop condition: ${loop.until}\nEvaluator: ${verdict.reason}`,
				)
			} else if (verdict.verdict === "IMPOSSIBLE") {
				await endLoop(
					sessionID,
					loop,
					"failed",
					`◎ Loop stopped: the stop condition can never be met.\nStop condition: ${loop.until}\nReason: ${verdict.reason}`,
				)
			}
			// NOT_MET: keep looping. Fixed cadences stay armed; self-paced loops
			// reschedule on the turn's session.idle.
		} catch (err) {
			// Transient evaluator failures keep the loop running.
			loop.lastReason = `evaluation error: ${String(err).slice(0, 200)}`
		} finally {
			loopEvaluating.delete(sessionID)
		}
	}

	return {
		"experimental.chat.system.transform": async (_input, output) => {
			try {
				if (output.system.includes(GOAL_SYSTEM_PROMPT)) return
				output.system.push(GOAL_SYSTEM_PROMPT)
			} catch {}
		},
		event: async ({ event }) => {
			if (event.type === "session.status") {
				sessionBusy.set(event.properties.sessionID, event.properties.status.type !== "idle")
				return
			}
			if (event.type === "session.idle") {
				const sessionID = event.properties.sessionID
				sessionBusy.set(sessionID, false)
				const goal = goals.get(sessionID)
				if (goal && goal.status === "active" && !evaluating.has(sessionID)) {
					// Background work in flight: defer the evaluation (the task
					// completion notification will trigger the next turn anyway).
					if (await backgroundWorkRunning(sessionID)) {
						goal.idleDeferrals += 1
						if (goal.idleDeferrals <= MAX_IDLE_DEFERRALS) {
							// Deferred — the loop handling below still runs.
						} else {
							// Too many deferrals: evaluate anyway against what's visible.
							goal.idleDeferrals = 0
							void evaluate(sessionID)
						}
					} else {
						goal.idleDeferrals = 0
						void evaluate(sessionID)
					}
				}
				const loop = loops.get(sessionID)
				if (loop && loop.status === "active") {
					if (loop.until && !loopEvaluating.has(sessionID)) void evaluateLoopUntil(sessionID)
					if (!loop.intervalMs) scheduleNextRun(sessionID)
				}
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
				// Unrecoverable classes clear the goal/loop (like Claude Code):
				// auth, credits/balance, model availability. Transient errors don't.
				const name = (props.error?.name ?? "").toLowerCase()
				const goal = props.sessionID ? goals.get(props.sessionID) : undefined
				if (goal && goal.status === "active" && isUnrecoverableErrorName(name)) {
					goal.status = "failed"
					goal.lastReason = `unrecoverable error: ${name}`
					goal.endedAt = Date.now()
					void persist(goals)
				}
				if (props.sessionID) {
					const loop = loops.get(props.sessionID)
					if (loop && loop.status === "active" && isUnrecoverableErrorName(name)) {
						void endLoop(props.sessionID, loop, "failed")
					}
				}
			}
		},

		tool: {
			goal_set: tool({
				description: `Set a completion condition for this session. The agent keeps working toward it automatically: after every turn an evaluator model checks the condition and continues the loop until it is met, impossible, or paused for lack of progress. The condition should be verifiable from the conversation (e.g. 'all tests in test/auth pass', 'git status is clean').

This tool backs the /goal command whenever its arguments are anything other than empty, "status", or a clear word. Never simulate the goal and never just do the work without setting it. Follow this order EXACTLY:
- FIRST tool call: goal_set with the arguments as the condition. Do nothing else before it — no analysis, no file reads, no writes.
- THEN work toward the condition. After each of your turns an evaluator checks it automatically; if it is not yet met you receive guidance as a message — continue working immediately without asking the user.
- Only stop when the evaluator reports MET, or the goal is paused/cleared.`,
				args: {
					condition: tool.schema.string().describe("The completion condition, verifiable from the conversation, taken from the /goal arguments. Max 4000 chars."),
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
				description: `Report the current /goal state for this session: condition, runtime, turns evaluated, last evaluator reason.

This is the /goal branch for empty arguments or "status". Report the output verbatim.`,
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
				description: `Clear the active /goal for this session.

This is the /goal branch for the argument words "clear", "stop", "off", "reset", "none" and "cancel". Report the output.`,
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

			loop: tool({
				description: `Start a self-driving loop for this session: the given prompt is run again and again without per-step prompting. Each iteration is dispatched into this session as a message; after each turn an evaluator (the same one /goal uses) judges the optional \`until\` stop condition and the loop ends when it holds, when the iteration cap is reached, or when loop_stop is called.

This tool backs the /loop command whenever its arguments are anything other than empty, "status", or a stop word. Call it FIRST, before any other work, passing the user's words as \`prompt\`:
- prompt: what to do on every iteration (required).
- every: fixed cadence between iterations, e.g. "5m", "90s", "2h" (minimum one minute). Omit it for self-paced timing: the prompt re-runs five minutes after each turn.
- until: the stop condition, verifiable from the conversation; the loop ends as soon as the evaluator judges it met.
- max_iterations: hard cap on iterations (default 40) so an unbounded loop cannot burn tokens.`,
				args: {
					prompt: tool.schema.string().describe("The prompt re-run on every iteration, taken from the /loop arguments."),
					every: tool.schema.string().optional().describe("Fixed cadence between iterations, e.g. \"5m\", \"90s\", \"2h\"; minimum 60s. Omit for self-paced timing: five minutes after each turn."),
					until: tool.schema.string().optional().describe("Optional stop condition, judged by the same evaluator as /goal; the loop stops once it holds."),
					max_iterations: tool.schema.number().optional().describe("Stop after this many iterations (default 40)."),
				},
				async execute(args, context) {
					if (!args.prompt.trim()) throw new Error("Prompt must not be empty")
					const sessionID = context.sessionID
					let intervalMs: number | undefined
					let clamped = false
					if (args.every !== undefined && args.every.trim()) {
						const requested = parseIntervalMs(args.every)
						if (requested === undefined) {
							throw new Error(`Could not parse the cadence "${args.every}". Use forms like "5m", "90s", "2h" (minimum 60s), or omit \`every\` for self-paced timing.`)
						}
						clamped = requested < LOOP_MIN_INTERVAL_MS
						intervalMs = Math.max(requested, LOOP_MIN_INTERVAL_MS)
					}
					const maxIterations =
						typeof args.max_iterations === "number" && Number.isFinite(args.max_iterations) && args.max_iterations >= 1
							? Math.floor(args.max_iterations)
							: LOOP_MAX_ITERATIONS
					// One loop per session: replacing one cancels its pending timer first.
					clearLoopTimer(sessionID)
					const loop: LoopState = {
						prompt: args.prompt.slice(0, MAX_CONDITION_CHARS),
						...(args.until && args.until.trim() ? { until: args.until.slice(0, MAX_CONDITION_CHARS) } : {}),
						...(intervalMs !== undefined ? { intervalMs } : {}),
						iterations: 1,
						maxIterations,
						status: "active",
						startedAt: Date.now(),
					}
					loops.set(sessionID, loop)
					// The first iteration runs immediately; later ones follow the cadence.
					const dispatched = await dispatchPrompt(sessionID, loop.prompt)
					if (!dispatched) {
						await endLoop(sessionID, loop, "stopped")
						return "◎ Loop could not start: the session rejected the first prompt."
					}
					if (loop.iterations >= loop.maxIterations) {
						// The cap was also the first iteration (e.g. max_iterations: 1).
						await endLoop(sessionID, loop, "finished", loopCapNotice(loop))
					} else {
						scheduleNextRun(sessionID)
					}
					const cadence =
						intervalMs !== undefined
							? `every ${humanDuration(intervalMs)}${clamped ? " (raised to the 60s minimum)" : ""}`
							: "self-paced (re-runs five minutes after each turn)"
					const lines = [
						`◎ Loop started (session-scoped). The prompt runs now and re-runs automatically.`,
						`Prompt: ${loop.prompt}`,
						`Cadence: ${cadence} · iteration 1 of ${maxIterations}`,
					]
					if (loop.until) {
						lines.push(`Stop condition: ${loop.until} — judged by the evaluator after each turn; the loop ends when it holds.`)
					} else {
						lines.push(`No stop condition — the loop ends at ${maxIterations} iterations, or sooner via loop_stop.`)
					}
					return lines.join("\n")
				},
			}),

			loop_stop: tool({
				description: `Stop the active loop in this session (one started with the loop tool). The loop's timer is cancelled and no further iterations are dispatched.

This is the /loop branch for the argument words "stop", "off", "cancel" and "clear". Report the output.`,
				args: {},
				async execute(_args, context) {
					const sessionID = context.sessionID
					clearLoopTimer(sessionID)
					const loop = loops.get(sessionID)
					if (!loop || loop.status !== "active") return "No active loop in this session."
					await endLoop(sessionID, loop, "stopped")
					return [
						`◎ Loop stopped after ${loop.iterations} iteration${loop.iterations === 1 ? "" : "s"}.`,
						`Prompt: ${loop.prompt}`,
					].join("\n")
				},
			}),
		},

		async dispose() {
			// Two schedulers must never run at once: cancel every loop timer this
			// instance created and mark its loops stopped so no idle event
			// re-arms or re-evaluates them.
			for (const timer of loopTimers.values()) clearTimeout(timer)
			loopTimers.clear()
			for (const loop of loops.values()) {
				if (loop.status === "active") {
					loop.status = "stopped"
					loop.endedAt = Date.now()
				}
			}
		},
	}
}

function humanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.round((ms % 60_000) / 1000)
	return `${m}m${s}s`
}

/** Parse a cadence like "5m", "90s" or "2h" into milliseconds. Returns undefined for unparseable input. */
function parseIntervalMs(raw: string): number | undefined {
	const m = raw.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours)?$/)
	if (!m) return undefined
	const n = Number(m[1])
	if (!Number.isFinite(n) || n <= 0) return undefined
	const unit = m[2] ?? "m"
	const ms = unit === "ms" ? n : unit.startsWith("h") ? n * 3_600_000 : unit.startsWith("s") ? n * 1_000 : n * 60_000
	return Math.round(ms)
}

const UNRECOVERABLE_ERROR_MARKERS = ["auth", "credential", "balance", "usage", "model"]

/** Unrecoverable error classes end the goal/loop (like Claude Code); transient ones don't. */
function isUnrecoverableErrorName(name: string): boolean {
	return UNRECOVERABLE_ERROR_MARKERS.some((marker) => name.includes(marker))
}
