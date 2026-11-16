/**
 * goal-indicator — opencode TUI plugin (opencode 2.3 TUI plugin API)
 *
 * Shows the live /goal state in the sidebar: condition, turns evaluated, and
 * the evaluator's most recent reason. Reads a state file published by the
 * server-side goal plugin (opencode/plugins/goal.ts).
 *
 * Install: opencode 2.3 loads a local TUI plugin from a DIRECTORY (its
 * `tui.tsx`), never from a single file. Add this file's directory to the
 * `plugins` array in ~/.config/opencode/cli.json (next to the
 * background-tasks sidebar plugin).
 */

import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface GoalSnapshot {
	sessionID: string
	condition: string
	startedAt: number
	turns: number
	lastReason?: string
	status: "active" | "achieved" | "failed" | "paused"
	endedAt?: number
}

const STATE_FILE = join(tmpdir(), "opencode-goal", "state.json")
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

export default Plugin.define({
	id: "pi-plugins/goal-indicator",
	setup(ctx) {
		const [goals, setGoals] = createSignal<GoalSnapshot[]>([])
		const [now, setNow] = createSignal(Date.now())

		const poll = async () => {
			try {
				const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as { goals?: GoalSnapshot[] }
				setGoals(raw.goals ?? [])
			} catch {
				setGoals([])
			}
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
				const sessionGoal = createMemo(() => goals().find((g) => g.sessionID === input.sessionID))
				return (
					<Show when={sessionGoal()}>
						{(goal) => (
							<box>
								<box flexDirection="row" gap={1}>
									<text fg={colorFor(goal().status)}>
										<b>
											◎ Goal {goal().status} · {humanDuration((goal().endedAt ?? now()) - goal().startedAt)} ·{" "}
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
