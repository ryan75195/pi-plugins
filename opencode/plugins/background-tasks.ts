/**
 * background-tasks — opencode plugin
 *
 * Claude Code-style background task support for opencode. Same feature set as
 * the pi extension in this repo, adapted to opencode's plugin API:
 *
 *   - bash_background: run a shell command without blocking the conversation,
 *     returns a task ID and output file path immediately.
 *   - task_output: read a task's output (optionally blocking until it finishes).
 *   - task_stop: kill a running task (entire process tree).
 *   - task_list: list all tasks with status.
 *   - Completion notifications: when a task exits, a message is sent into the
 *     originating session. If the session is idle, the agent reacts immediately
 *     (prompt_async). If busy, the notification is queued and flushed on the
 *     next `session.idle` event.
 *   - TUI toast on completion via client.tui.showToast (best-effort).
 *
 * Install: copy (or symlink) this file into ~/.config/opencode/plugins/ (global)
 * or .opencode/plugins/ (project).
 */

import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { spawn, execSync, type ChildProcess } from "node:child_process"
import { createWriteStream } from "node:fs"
import { mkdir, open, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024 // 50MB cap per task
const NOTIFICATION_TAIL_CHARS = 2048 // output tail included in completion notification
const DEFAULT_TAIL_CHARS = 4096 // default tail returned by task_output
const OUTPUT_DIR = join(tmpdir(), "opencode-background-tasks")

type TaskStatus = "running" | "completed" | "failed" | "stopped"

interface BgTask {
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
	child?: ChildProcess
	truncated: boolean
	notified: boolean
	stopRequested: boolean
	waiters: Array<() => void>
	timeoutTimer?: ReturnType<typeof setTimeout>
}

/**
 * Serialised task state shared with the TUI sidebar plugin
 * (opencode/tui/background-tasks-sidebar.tsx) via a JSON file.
 */
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

const STATE_FILE = join(OUTPUT_DIR, "state.json")

function snapshot(t: BgTask): TaskSnapshot {
	return {
		id: t.id,
		sessionID: t.sessionID,
		command: t.command,
		description: t.description,
		pid: t.pid,
		startedAt: t.startedAt,
		finishedAt: t.finishedAt,
		exitCode: t.exitCode,
		status: t.status,
		outputFile: t.outputFile,
		truncated: t.truncated,
	}
}

async function persistState(tasks: Map<string, BgTask>) {
	await persistStateMap(new Map([...tasks.values()].map((t) => [t.id, snapshot(t) as unknown as BgTask])))
}

async function persistStateMap(snapshots: Map<string, unknown>) {
	try {
		await mkdir(OUTPUT_DIR, { recursive: true })
		await writeFile(STATE_FILE, JSON.stringify({ updatedAt: Date.now(), tasks: [...snapshots.values()] }))
	} catch {
		// Best-effort state sharing with the TUI; never fail task handling over it.
	}
}

function humanDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.round((ms % 60_000) / 1000)
	return `${m}m${s}s`
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

export const BackgroundTasksPlugin: Plugin = async ({ client, directory }) => {
	const tasks = new Map<string, BgTask>()
	// Track which sessions are busy so notifications trigger a reply when idle
	// and queue when busy (flushed on session.idle).
	const sessionBusy = new Map<string, boolean>()
	const pendingNotifications = new Map<string, string[]>() // sessionID -> messages

	function running(): BgTask[] {
		return [...tasks.values()].filter((t) => t.status === "running")
	}

	async function tailOfFile(path: string, maxChars: number): Promise<{ text: string; truncated: boolean }> {
		let fh: Awaited<ReturnType<typeof open>> | undefined
		try {
			fh = await open(path, "r")
			const size = (await fh.stat()).size
			const start = Math.max(0, size - maxChars)
			const len = size - start
			const buf = Buffer.alloc(len)
			await fh.read(buf, 0, len, start)
			return { text: buf.toString("utf8"), truncated: start > 0 }
		} catch {
			return { text: "", truncated: false }
		} finally {
			await fh?.close()
		}
	}

	function taskLabel(t: BgTask): string {
		return t.description ? `"${t.description}" (${t.command})` : t.command
	}

	async function deliverNotification(sessionID: string, text: string) {
		// prompt_async sends the message into the session and triggers an agent
		// response. Errors are swallowed (e.g. non-TUI/headless runs).
		try {
			await client.session.promptAsync({
				path: { id: sessionID },
				body: {
					parts: [{ type: "text", text }],
				},
				query: { directory },
			})
		} catch {
			// Session may have been deleted or the server is shutting down.
		}
	}

	async function notifyCompletion(task: BgTask) {
		if (task.notified) return
		task.notified = true
		const { text } = await tailOfFile(task.outputFile, NOTIFICATION_TAIL_CHARS)
		const duration = humanDuration((task.finishedAt ?? Date.now()) - task.startedAt)
		const exit = task.exitCode === null ? "no exit code" : `exit code ${task.exitCode}`
		const header = `Background task ${task.id} ${statusIcon(task.status)} ${task.status} (${exit}, ${duration}): ${taskLabel(task)}`
		const tail = text.trim() ? `\n\nLast output:\n${text}` : "\n\n(no output)"
		const message = `${header}${tail}`

		const busy = sessionBusy.get(task.sessionID) ?? false
		if (busy) {
			const queue = pendingNotifications.get(task.sessionID) ?? []
			queue.push(message)
			pendingNotifications.set(task.sessionID, queue)
		} else {
			await deliverNotification(task.sessionID, message)
		}

		// Best-effort toast for the human (TUI only; silently ignored elsewhere).
		try {
			await client.tui.showToast({
				body: {
					title: `Background task ${task.status}`,
					message: `${task.id}: ${task.command}`,
					variant: task.status === "completed" ? "success" : task.status === "stopped" ? "warning" : "error",
					duration: 4000,
				},
				query: { directory },
			})
		} catch {
			// Not in TUI mode, or TUI not reachable.
		}
	}

	function startTask(command: string, description: string | undefined, timeoutMs: number | undefined, sessionID: string): BgTask {
		const id = randomUUID().slice(0, 8)
		const outputFile = join(OUTPUT_DIR, `${id}.log`)
		const child = spawn(command, {
			shell: true,
			cwd: directory,
			env: { ...process.env, OPENCODE_BG_TASK_ID: id },
			stdio: ["ignore", "pipe", "pipe"],
		})

		const task: BgTask = {
			id,
			sessionID,
			command,
			description,
			pid: child.pid,
			startedAt: Date.now(),
			exitCode: null,
			status: "running",
			outputFile,
			child,
			truncated: false,
			notified: false,
			stopRequested: false,
			waiters: [],
		}
		tasks.set(id, task)
		void persistState(tasks)

		let bytes = 0
		const out = createWriteStream(outputFile, { flags: "a" })
		const onData = (chunk: Buffer) => {
			if (task.truncated) return
			if (bytes + chunk.length > MAX_OUTPUT_BYTES) {
				task.truncated = true
				out.end(`\n[opencode background-tasks] output limit (${Math.floor(MAX_OUTPUT_BYTES / 1024 / 1024)}MB) reached; further output discarded. The process keeps running; use task_output for status.\n`)
				return
			}
			bytes += chunk.length
			out.write(chunk)
		}
		child.stdout?.on("data", onData)
		child.stderr?.on("data", onData)

		if (timeoutMs && timeoutMs > 0) {
			task.timeoutTimer = setTimeout(() => {
				void stopTask(task)
			}, timeoutMs)
			task.timeoutTimer.unref?.()
		}

		child.on("close", (code) => {
			if (task.timeoutTimer) clearTimeout(task.timeoutTimer)
			task.finishedAt = Date.now()
			task.exitCode = code
			if (task.status === "running") {
				task.status = task.stopRequested ? "stopped" : code === 0 ? "completed" : "failed"
			}
			if (!out.writableEnded) out.end()
			void notifyCompletion(task)
			for (const w of task.waiters) w()
			task.waiters = []
			void persistState(tasks)
		})

		child.on("error", (err) => {
			// Spawn itself failed (e.g. shell not found); surface as failed task.
			if (task.status === "running") {
				task.finishedAt = Date.now()
				task.status = "failed"
				task.exitCode = null
				out.end(`\n[opencode background-tasks] failed to start: ${err.message}\n`)
				void notifyCompletion(task)
				for (const w of task.waiters) w()
				task.waiters = []
				void persistState(tasks)
			}
		})

		return task
	}

	async function stopTask(task: BgTask): Promise<void> {
		if (task.status !== "running") return
		task.stopRequested = true
		if (process.platform === "win32") {
			if (task.pid) {
				// Kill the whole process tree (shell + children, e.g. dev servers).
				try {
					execSync(`taskkill /pid ${task.pid} /T /F`, { stdio: "ignore" })
				} catch {
					task.child?.kill("SIGKILL")
				}
			} else {
				task.child?.kill("SIGKILL")
			}
		} else {
			task.child?.kill("SIGTERM")
			const killer = setTimeout(() => task.child?.kill("SIGKILL"), 5000)
			killer.unref?.()
		}
	}

	function waitFor(task: BgTask, timeoutMs: number): Promise<boolean> {
		if (task.status !== "running") return Promise.resolve(true)
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs)
			timer.unref?.()
			task.waiters.push(() => {
				clearTimeout(timer)
				resolve(true)
			})
		})
	}

	return {
		dispose: async () => {
			// Stop our running tasks and drop our entries from the shared state
			// file so the TUI sidebar doesn't show stale rows.
			for (const t of running()) {
				void stopTask(t)
			}
			const ourIds = new Set(tasks.keys())
			tasks.clear()
			try {
				const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as { tasks?: TaskSnapshot[] }
				await persistStateMap(new Map((raw.tasks ?? []).filter((t) => !ourIds.has(t.id)).map((t) => [t.id, { ...t } as unknown as BgTask])))
			} catch {
				await persistState(tasks)
			}
		},

		event: async ({ event }) => {
			if (event.type === "session.status") {
				sessionBusy.set(event.properties.sessionID, event.properties.status.type !== "idle")
			} else if (event.type === "session.idle") {
				sessionBusy.set(event.properties.sessionID, false)
				// Flush any queued completion notifications for this session.
				const queue = pendingNotifications.get(event.properties.sessionID)
				if (queue?.length) {
					pendingNotifications.set(event.properties.sessionID, [])
					const all = queue.join("\n\n---\n\n")
					await deliverNotification(event.properties.sessionID, all)
				}
			} else if (event.type === "session.deleted") {
				sessionBusy.delete(event.properties.info.id)
				pendingNotifications.delete(event.properties.info.id)
			}
		},

		tool: {
			bash_background: tool({
				description:
					"Run a shell command in the background without blocking. Returns a task ID and output file path immediately. " +
					"Use for long-running processes: dev servers, builds, watchers, test suites, installs. " +
					"Retrieve output later with task_output (use block:true to wait for completion) or by reading the output file.",
				args: {
					command: tool.schema.string().describe("The shell command to run"),
					description: tool.schema.string().optional().describe("Short human-readable label for this task"),
					timeout_ms: tool.schema.number().optional().describe("Automatically stop the task after this many milliseconds"),
				},
				async execute(args, context) {
					await mkdir(OUTPUT_DIR, { recursive: true })
					const task = startTask(args.command, args.description, args.timeout_ms, context.sessionID)
					return [
						`Started background task ${task.id}`,
						`Command: ${task.command}`,
						`Output file: ${task.outputFile}`,
						``,
						`Use task_output with task_id "${task.id}" to check on it (block:true waits for completion), or read the output file directly.`,
					].join("\n")
				},
			}),

			task_output: tool({
				description:
					"Get the status and output of a background task. Set block:true to wait for completion (up to timeout_ms, default 30s). " +
					"Returns the last tail_bytes of output (default 4096) plus status, exit code and duration.",
				args: {
					task_id: tool.schema.string().describe("The task ID returned by bash_background"),
					block: tool.schema.boolean().optional().describe("Wait for the task to finish before returning (default false)"),
					timeout_ms: tool.schema.number().optional().describe("Max time to wait when blocking (default 30000)"),
					tail_bytes: tool.schema.number().optional().describe("How many bytes of output tail to return (default 4096)"),
				},
				async execute(args, context) {
					const task = tasks.get(args.task_id)
					if (!task) throw new Error(`Unknown task ID: ${args.task_id}. Use task_list to see known tasks.`)
					if (args.block && task.status === "running") {
						await waitFor(task, args.timeout_ms ?? 30_000)
					}
					const { text, truncated } = await tailOfFile(task.outputFile, args.tail_bytes ?? DEFAULT_TAIL_CHARS)
					const duration = humanDuration((task.finishedAt ?? Date.now()) - task.startedAt)
					const statusLine = `${statusIcon(task.status)} ${task.status} (${duration}${task.exitCode === null ? "" : `, exit ${task.exitCode}`})`
					const body = text.trim()
						? `${statusLine}\n\n${truncated ? "[...earlier output omitted...]\n" : ""}${text}`
						: `${statusLine}\n\n(no output yet)`
					return body
				},
			}),

			task_stop: tool({
				description: "Stop a running background task. Kills the entire process tree.",
				args: {
					task_id: tool.schema.string().describe("The task ID returned by bash_background"),
				},
				async execute(args) {
					const task = tasks.get(args.task_id)
					if (!task) throw new Error(`Unknown task ID: ${args.task_id}. Use task_list to see known tasks.`)
					if (task.status !== "running") {
						return `Task ${task.id} already finished: ${task.status}`
					}
					await stopTask(task)
					return `Stopping task ${task.id} (${task.command}). Use task_output to confirm it exited.`
				},
			}),

			task_list: tool({
				description: "List all background tasks from this session with status, exit codes and output file paths.",
				args: {},
				async execute() {
					if (tasks.size === 0) return "No background tasks have been started this session."
					return [...tasks.values()]
						.map((t) => {
							const duration = humanDuration((t.finishedAt ?? Date.now()) - t.startedAt)
							const exit = t.exitCode === null ? "" : `, exit ${t.exitCode}`
							return `${statusIcon(t.status)} ${t.id} ${t.status} (${duration}${exit}) ${taskLabel(t)}\n   output file: ${t.outputFile}`
						})
						.join("\n")
				},
			}),
		},
	}
}
