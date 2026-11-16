/**
 * goal-indicator — opencode TUI plugin (opencode 2.3 TUI plugin API)
 *
 * Shows the live /goal (or /loop) state in the sidebar: condition, turns
 * evaluated, and the evaluator's most recent reason. Reads the per-session
 * state files written by goal-loop (opencode-architect's plugin/goal-loop.ts:
 * <stateDir>/<repoKey>.<sessionID>.json, stateDir = $OPENCODE_GOAL_STATE_DIR
 * or ~/.config/opencode/state/goal), and still the shared state file of the
 * older in-repo goal plugin (opencode/plugins/goal.ts) when that runs.
 *
 * Install: opencode 2.3 loads a local TUI plugin from a DIRECTORY (its
 * `tui.tsx`), never from a single file. Add this file's directory to the
 * `plugins` array in ~/.config/opencode/cli.json (next to the
 * background-tasks sidebar plugin).
 */

import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { readdir, readFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"

interface GoalSnapshot {
	sessionID: string
	/** "Goal" or "Loop": the header's label. */
	label: string
	condition: string
	startedAt: number
	turns: number
	lastReason?: string
	status: "active" | "achieved" | "failed" | "paused"
	endedAt?: number
}

/** The fields of goal-loop's per-session State that the sidebar shows. */
interface GoalLoopState {
	kind: "goal" | "loop"
	text: string
	until?: string | null
	status: "active" | "paused" | "done" | "failed"
	turns: number
	startedAt: number
	lastReason?: string
}

const STATE_FILE = join(tmpdir(), "opencode-goal", "state.json")
// goal-loop's stateDir(), resolved per poll like the writer does.
function goalLoopDir(): string {
	const override = process.env.OPENCODE_GOAL_STATE_DIR
	return override ? override : join(homedir(), ".config", "opencode", "state", "goal")
}
// <repoKey>.<sessionID with anything outside [A-Za-z0-9_-] as "_">.json; the
// repoKey hashes the server's directory, so match on the session part only.
const GOAL_LOOP_FILE = /^[0-9a-f]{12}\.([A-Za-z0-9_-]+)\.json$/
function safeSessionID(sessionID: string): string {
	return sessionID.replace(/[^A-Za-z0-9_-]/g, "_")
}
const POLL_MS = 1500
const MAX_CONDITION = 64
const MAX_REASON = 72

function humanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.round(ms / 1000)}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.round((ms % 60_000) / 1000)
	return `${m}m${s}s`
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

/** goal-loop's per-session files, keyed by the session id as written in the file name. */
async function readGoalLoop(): Promise<GoalSnapshot[]> {
	const dir = goalLoopDir()
	let names: string[]
	try {
		names = await readdir(dir)
	} catch {
		return []
	}
	const out: GoalSnapshot[] = []
	for (const name of names) {
		const match = GOAL_LOOP_FILE.exec(name)
		if (!match) continue
		try {
			const state = JSON.parse(await readFile(join(dir, name), "utf8")) as GoalLoopState
			if ((state.kind !== "goal" && state.kind !== "loop") || typeof state.text !== "string") continue
			out.push({
				sessionID: match[1],
				label: state.kind === "loop" ? "Loop" : "Goal",
				condition: state.kind === "loop" && state.until ? `${state.text} · until ${state.until}` : state.text,
				startedAt: state.startedAt,
				turns: state.turns ?? 0,
				lastReason: state.lastReason || undefined,
				status: state.status === "done" ? "achieved" : state.status,
			})
		} catch {
			// a file mid-write or removed between readdir and read: next poll
		}
	}
	return out
}

/** The older goal plugin's shared file (opencode/plugins/goal.ts). */
async function readLegacy(): Promise<GoalSnapshot[]> {
	try {
		const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as { goals?: Array<Omit<GoalSnapshot, "label">> }
		return (raw.goals ?? []).map((g) => ({ ...g, label: "Goal" }))
	} catch {
		return []
	}
}

export default Plugin.define({
	id: "pi-plugins/goal-indicator",
	setup(ctx) {
		const [goals, setGoals] = createSignal<GoalSnapshot[]>([])
		const [now, setNow] = createSignal(Date.now())

		const poll = async () => {
			setGoals([...(await readGoalLoop()), ...(await readLegacy())])
		}
		const pollTimer = setInterval(poll, POLL_MS)
		const tickTimer = setInterval(() => setNow(Date.now()), 1000)
		void poll()

		// The theme is read at render time so a theme switch recolours the header.
		function colorFor(status: GoalSnapshot["status"]): RGBA {
			const theme = ctx.theme
			switch (status) {
				case "active":
					return theme.text.action.primary.base
				case "achieved":
					return theme.text.feedback.success.base
				case "failed":
					return theme.text.feedback.error.base
				default:
					return theme.text.muted
			}
		}

		const unclaim = ctx.ui.slot({
			append: "sidebar.content",
			render(input) {
				const sessionGoal = createMemo(() => {
					// goal-loop names its file after the sanitised id; the newest run wins
					// if one session has files under two directories.
					const id = safeSessionID(input.sessionID)
					const mine = goals().filter((g) => g.sessionID === input.sessionID || g.sessionID === id)
					return mine.sort((a, b) => b.startedAt - a.startedAt)[0]
				})
				return (
					<Show when={sessionGoal()}>
						{(goal) => (
							<box>
								<box flexDirection="row" gap={1}>
									<text fg={colorFor(goal().status)}>
										<b>
											◎ {goal().label} {goal().status} · {humanDuration((goal().endedAt ?? now()) - goal().startedAt)} ·{" "}
											{goal().turns} turn{goal().turns === 1 ? "" : "s"}
										</b>
									</text>
								</box>
								<text fg={ctx.theme.text.base}>{truncate(goal().condition, MAX_CONDITION)}</text>
								<Show when={goal().lastReason}>
									<text fg={ctx.theme.text.muted}>{truncate(`↳ ${goal().lastReason}`, MAX_REASON)}</text>
								</Show>
							</box>
						)}
					</Show>
				)
			},
		})

		return () => {
			clearInterval(pollTimer)
			clearInterval(tickTimer)
			unclaim()
		}
	},
})
