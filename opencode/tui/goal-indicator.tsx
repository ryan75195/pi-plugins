/**
 * goal-indicator — opencode TUI plugin
 *
 * Shows the live /goal state in the sidebar: condition, turns evaluated, and
 * the evaluator's most recent reason. Reads a state file published by the
 * server-side goal plugin (opencode/plugins/goal.ts).
 *
 * Install: add this file to the `plugin` array in tui.json (next to the
 * background-tasks sidebar plugin).
 */

import type { TuiPlugin, TuiThemeCurrent } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface SlotProps {
	session_id: string
}

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
const SIDEBAR_ORDER = 450 // above the background-tasks section (500)
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

const tui: TuiPlugin = async (api) => {
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
	poll()
	const stop = () => {
		clearInterval(pollTimer)
		clearInterval(tickTimer)
	}
	api.lifecycle.onDispose(stop)
	onCleanup(stop)

	function colorFor(status: "active" | "achieved" | "failed" | "paused"): string {
		switch (status) {
			case "active":
				return "primary"
			case "achieved":
				return "success"
			case "failed":
				return "error"
			default:
				return "textMuted"
		}
	}

	api.slots.register({
		order: SIDEBAR_ORDER,
		slots: {
			sidebar_content(_ctx: unknown, props: SlotProps) {
				const sessionGoal = createMemo(() => goals().find((g) => g.sessionID === props.session_id))
				return (
					<Show when={sessionGoal()}>
						{(goal) => (
							<box>
								<box flexDirection="row" gap={1}>
									<text fg={(api.theme.current as unknown as Record<string, string>)[colorFor(goal().status)]}>
										<b>
											◎ Goal {goal().status} · {humanDuration((goal().endedAt ?? now()) - goal().startedAt)} ·{" "}
											{goal().turns} turn{goal().turns === 1 ? "" : "s"}
										</b>
									</text>
								</box>
								<text fg={api.theme.current.text}>{truncate(goal().condition, MAX_CONDITION)}</text>
								<Show when={goal().lastReason}>
									<text fg={api.theme.current.textMuted}>{truncate(`↳ ${goal().lastReason}`, MAX_REASON)}</text>
								</Show>
							</box>
						)}
					</Show>
				)
			},
		},
	})
}

export default { id: "pi-plugins/goal-indicator", tui }
