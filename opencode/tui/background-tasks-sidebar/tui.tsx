/**
 * background-tasks-sidebar — opencode TUI plugin (opencode 2.3 TUI plugin API)
 *
 * Renders a collapsible "Background tasks" section in the TUI sidebar (the
 * panel on the right, toggled with ctrl+x b). Pairs with the server-side
 * plugin opencode/plugins/background-tasks.ts, which publishes task state to
 * a JSON file; this plugin polls it and renders:
 *
 *   collapsed (default):  ⠼ Background tasks 1/2 ▸ dev server 1m12s
 *   expanded:             full rows with elapsed time, exit codes; clicking a
 *                         running row opens a confirm dialog to stop it
 *
 * Install: opencode 2.3 loads a local TUI plugin from a DIRECTORY (its
 * `tui.tsx`), never from a single file. Add this file's directory to the
 * `plugins` array in ~/.config/opencode/cli.json:
 *
 *   { "plugins": ["/absolute/path/to/opencode/tui/background-tasks-sidebar"] }
 */

import { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import { createMemo, createSignal, For, Show } from "solid-js"
import { readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

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
	foreground?: boolean
	backgrounded?: boolean
}

const STATE_FILE = join(tmpdir(), "opencode-background-tasks", "state.json")
const REQUESTS_FILE = join(tmpdir(), "opencode-background-tasks", "requests.json")
const HINT_MAX_LABEL = 44
const POLL_MS = 700
const TICK_MS = 1000
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

/**
 * Ask the server plugin to stop a task via the requests file. Going through
 * the server (instead of killing directly) marks the task as stopped so it
 * is removed from the registry and drops out of the sidebar.
 */
async function requestStopTask(task: TaskSnapshot): Promise<void> {
	await writeRequest((req) => ({ ...req, stop: [...new Set([...(req.stop ?? []), task.id])] }))
}

/**
 * Ask the server plugin to background the foreground task(s) of a session
 * (ctrl+b). The waiting bash tool call returns immediately and the
 * conversation is freed; the result arrives as a completion notification.
 */
async function requestBackgroundSession(sessionID: string): Promise<void> {
	await writeRequest((req) => ({ ...req, backgroundSessions: [...new Set([...(req.backgroundSessions ?? []), sessionID])] }))
}

async function writeRequest(mutate: (req: { stop?: string[]; backgroundSessions?: string[] }) => { stop?: string[]; backgroundSessions?: string[] }): Promise<void> {
	let current: { stop?: string[]; backgroundSessions?: string[] } = {}
	try {
		current = JSON.parse(await readFile(REQUESTS_FILE, "utf8"))
	} catch {
		// no requests yet
	}
	await writeFile(REQUESTS_FILE, JSON.stringify(mutate(current)))
}

async function readTasks(): Promise<TaskSnapshot[]> {
	try {
		const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as { tasks?: TaskSnapshot[] }
		return raw.tasks ?? []
	} catch {
		return []
	}
}

export default Plugin.define({
	id: "pi-plugins/background-tasks-sidebar",
	setup(ctx) {
		const [tasks, setTasks] = createSignal<TaskSnapshot[]>([])
		const [now, setNow] = createSignal(Date.now())
		const [expanded, setExpanded] = createSignal(false)

		function foregroundForSession(sessionID: string): TaskSnapshot | undefined {
			return tasks().find((t) => t.sessionID === sessionID && t.foreground && !t.backgrounded && t.status === "running" && pidAlive(t.pid))
		}

		const poll = async () => {
			setTasks(await readTasks())
		}
		const pollTimer = setInterval(poll, POLL_MS)
		const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)
		void poll()

		// The theme is read at render time so a theme switch recolours the rows.
		function colorFor(status: TaskStatus, alive = true): RGBA {
			const theme = ctx.theme
			if (status === "running" && !alive) return theme.text.muted
			switch (status) {
				case "running":
					return theme.text.action.primary.base
				case "completed":
					return theme.text.feedback.success.base
				case "stopped":
					return theme.text.feedback.warning.base
				case "failed":
					return theme.text.feedback.error.base
			}
		}

		function requestStop(task: TaskSnapshot) {
			ctx.ui.toast.show({
				title: "Stopping task",
				message: `${task.id}: ${task.command}`,
				variant: "warning",
				duration: 3000,
			})
			void requestStopTask(task).then(() => poll())
		}

		// NOTE: triggered on mouse-UP, not mouse-down. On mouse-down the dialog
		// opens mid-click and the subsequent mouse-up dismisses it immediately.
		function confirmStop(task: TaskSnapshot) {
			ctx.ui.dialog
				.confirm({ title: "Stop background task", message: `${task.id}: ${task.command}` })
				.then((confirmed) => {
					if (confirmed) requestStop(task)
				})
				.catch(() => requestStop(task))
		}

		function summaryLine(list: TaskSnapshot[]): string {
			const runCount = list.filter((t) => t.status === "running" && pidAlive(t.pid)).length
			return runCount > 0 ? `Background tasks · ${runCount} running` : `Background tasks · idle`
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

		// ctrl+b: background the foreground command of the current session.
		// opencode 2.3 binds ctrl+b itself ("Background blocking session tools"),
		// so this layer sits above it and hands the key on (returns false) when
		// none of OUR commands is blocking the session.
		const unclaimKeymap = ctx.ui.slot({
			append: "app",
			render() {
				ctx.keymap.layer(() => ({
					priority: 1,
					commands: [
						{
							id: "background_tasks.background",
							title: "Background running command",
							description: "Move the blocking shell command to the background and free the chat",
							group: "Background tasks",
							bind: "ctrl+b",
							run() {
								const current = ctx.ui.router.current()
								if (current.type !== "session") return false
								const task = foregroundForSession(current.sessionID)
								if (!task) return false
								void requestBackgroundSession(current.sessionID)
								ctx.ui.toast.show({
									title: "Moved to background",
									message: `${task.id}: ${truncate(task.command, 60)} — you'll get the result when it finishes`,
									variant: "success",
									duration: 4000,
								})
							},
						},
					],
				}))
				return null
			},
		})

		// Hint above the prompt while a command is blocking the conversation
		// (like Claude Code's ctrl+b affordance). V1 put this in the
		// app_bottom slot, which opencode 2.3 no longer has.
		const unclaimHint = ctx.ui.slot({
			append: "session.composer.top",
			render(input) {
				const task = createMemo(() => foregroundForSession(input.sessionID))
				return (
					<Show when={task()}>
						{(t) => (
							<box flexDirection="row" paddingLeft={1}>
								<text fg={ctx.theme.text.action.primary.base}>ctrl+b</text>
								<text fg={ctx.theme.text.muted}>
									{` background · ${t().id} ${truncate(t().command, HINT_MAX_LABEL)} ${humanDuration(now() - t().startedAt)}`}
								</text>
							</box>
						)}
					</Show>
				)
			},
		})

		const unclaimSidebar = ctx.ui.slot({
			append: "sidebar.content",
			render(input) {
				const sessionTasks = createMemo(() =>
					tasks().filter(
						// Mirror the server-side filter so stale state written by an
						// older plugin process can't leak foreground rows in here.
						(t) => !(t.foreground && !t.backgrounded) && t.sessionID === input.sessionID,
					),
				)
				return (
					<Show when={sessionTasks().length > 0}>
						<box>
							<box flexDirection="row" gap={1} onMouseDown={() => setExpanded((x) => !x)}>
								<text fg={ctx.theme.text.action.primary.base}>
									<b>
										{expanded() ? "▼" : "▸"} {summaryLine(sessionTasks())}
									</b>
								</text>
							</box>
							<Show when={expanded()}>
								<For each={sessionTasks()}>
									{(task) => (
										<text
											fg={colorFor(task.status, pidAlive(task.pid))}
											onMouseUp={() => {
												if (task.status === "running" && pidAlive(task.pid)) confirmStop(task)
											}}
										>
											{rowText(task)}
										</text>
									)}
								</For>
							</Show>
						</box>
					</Show>
				)
			},
		})

		return () => {
			clearInterval(pollTimer)
			clearInterval(tickTimer)
			unclaimKeymap()
			unclaimHint()
			unclaimSidebar()
		}
	},
})
