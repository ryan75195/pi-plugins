/**
 * background-tasks-sidebar — opencode TUI plugin
 *
 * Renders a collapsible "Background tasks" section in the TUI sidebar (the
 * panel on the right, toggled with ctrl+x b). Pairs with the server-side
 * plugin opencode/plugins/background-tasks.ts, which publishes task state to
 * a JSON file; this plugin polls it and renders:
 *
 *   collapsed (default):  ⠼ Background tasks 1/2 ▸ dev server 1m12s
 *   expanded:             full rows with elapsed time, exit codes, and
 *                         click-to-stop (inline two-click confirm)
 *
 * Install: add the path to this file to the `plugin` array in
 * ~/.config/opencode/tui.json (or .opencode/tui.json):
 *
 *   { "plugin": ["/absolute/path/to/background-tasks-sidebar.tsx"] }
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { execFile } from "node:child_process"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface SlotProps {
	session_id: string
}

type TaskStatus = "running" | "completed" | "failed" | "stopped"

interface TaskSnapshot {
	id: string
	sessionID: string
	command: string
	description?: string
	pid: number | undefined
	startedAt: number
	finishedAt?: number
	exitCode: number | null
	status: TaskStatus
	outputFile: string
	truncated: boolean
}

const STATE_FILE = join(tmpdir(), "opencode-background-tasks", "state.json")
const POLL_MS = 700
const TICK_MS = 1000
const SIDEBAR_ORDER = 500
const CONFIRM_RESET_MS = 5000
const MAX_LABEL_WIDTH = 48

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]

function spinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / 90) % SPINNER_FRAMES.length]
}

function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "running":
			return "▶"
		case "completed":
			return "✔"
		case "stopped":
			return "■"
		case "failed":
			return "✘"
	}
}

function humanDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.round((ms % 60_000) / 1000)
	return `${m}m${s}s`
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

function killTree(pid: number): void {
	if (process.platform === "win32") {
		execFile("taskkill", ["/pid", String(pid), "/T", "/F"], () => {})
	} else {
		try {
			process.kill(pid, "SIGTERM")
		} catch {
			// already gone
		}
	}
}

async function readTasks(): Promise<TaskSnapshot[]> {
	try {
		const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as { tasks?: TaskSnapshot[] }
		return raw.tasks ?? []
	} catch {
		return []
	}
}

const tui: TuiPlugin = async (api) => {
	const [tasks, setTasks] = createSignal<TaskSnapshot[]>([])
	const [now, setNow] = createSignal(Date.now())
	const [expanded, setExpanded] = createSignal(false)
	const [confirmingId, setConfirmingId] = createSignal<string | null>(null)
	let confirmTimer: ReturnType<typeof setTimeout> | undefined

	const poll = async () => {
		setTasks(await readTasks())
	}
	const pollTimer = setInterval(poll, POLL_MS)
	const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)
	poll()

	const stopPolling = () => {
		clearInterval(pollTimer)
		clearInterval(tickTimer)
		if (confirmTimer) clearTimeout(confirmTimer)
	}
	api.lifecycle.onDispose(stopPolling)
	onCleanup(stopPolling)

	function armConfirm(id: string) {
		setConfirmingId(id)
		if (confirmTimer) clearTimeout(confirmTimer)
		confirmTimer = setTimeout(() => setConfirmingId(null), CONFIRM_RESET_MS)
	}

	function stopTask(task: TaskSnapshot) {
		setConfirmingId(null)
		api.ui.toast({
			title: "Stopping task",
			message: `${task.id}: ${task.command}`,
			variant: "warning",
			duration: 3000,
		})
		if (task.pid) killTree(task.pid)
		poll()
	}

	function colorFor(status: TaskStatus, alive = true): string {
		if (status === "running" && !alive) return "textMuted"
		switch (status) {
			case "running":
				return "primary"
			case "completed":
				return "success"
			case "stopped":
				return "warning"
			case "failed":
				return "error"
		}
	}

	function rowText(task: TaskSnapshot): string {
		const alive = pidAlive(task.pid)
		const icon = task.status === "running" && alive ? spinnerFrame() : statusIcon(task.status)
		const elapsed = humanDuration((task.finishedAt ?? now()) - task.startedAt)
		const right =
			task.status === "running" ? (alive ? elapsed : `${elapsed} · gone`) : `${elapsed}${task.exitCode === null ? "" : ` · exit ${task.exitCode}`}`
		const label = task.description ? `${task.description} (${task.command})` : task.command
		return `${icon} ${task.id} ${truncate(label, MAX_LABEL_WIDTH)}  ${right}`
	}

	function summaryLine(list: TaskSnapshot[]): string {
		const runCount = list.filter((t) => t.status === "running").length
		const head = `${runCount > 0 ? spinnerFrame() : statusIcon(list[0]!.status)} Background tasks ${runCount ? `${runCount} running` : `${list.length} finished`}`
		const mostRelevant = list.find((t) => t.status === "running" && pidAlive(t.pid)) ?? list[0]!
		const label = mostRelevant.description
			? `${mostRelevant.description} (${mostRelevant.command})`
			: mostRelevant.command
		const elapsed = humanDuration((mostRelevant.finishedAt ?? now()) - mostRelevant.startedAt)
		return `${head} ▸ ${truncate(label, MAX_LABEL_WIDTH)} ${elapsed}`
	}

	api.slots.register({
		order: SIDEBAR_ORDER,
		slots: {
			sidebar_content(_ctx: unknown, props: SlotProps) {
				const sessionTasks = createMemo(() => tasks().filter((t) => t.sessionID === props.session_id))
				return (
					<Show when={sessionTasks().length > 0}>
						<box>
							<box flexDirection="row" gap={1} onMouseDown={() => setExpanded((x) => !x)}>
								<text fg={api.theme.current.primary}>
									<b>{expanded() ? "▼" : "▸"} {summaryLine(sessionTasks())}</b>
								</text>
							</box>
							<Show when={expanded()}>
								<For each={sessionTasks()}>
									{(task) => {
										const alive = pidAlive(task.pid)
										const running = task.status === "running" && alive
										const color = colorFor(task.status, alive)
										return (
											<Show
												when={running && confirmingId() === task.id}
												fallback={
													<box
														flexDirection="row"
														justifyContent="space-between"
														onMouseDown={() => {
															if (running) armConfirm(task.id)
														}}
													>
														<text fg={color}>{rowText(task)}</text>
													</box>
												}
											>
												<box flexDirection="row" gap={2}>
													<text fg={api.theme.current.error} attributes="bold" onMouseDown={() => stopTask(task)}>
														[stop {task.id}]
													</text>
													<text fg={api.theme.current.textMuted} onMouseDown={() => setConfirmingId(null)}>
														[keep]
													</text>
												</box>
											</Show>
										)
									}}
								</For>
							</Show>
						</box>
					</Show>
				)
			},
		},
	})
}

export default { id: "pi-plugins/background-tasks-sidebar", tui }
