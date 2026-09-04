/**
 * background-tasks — pi extension
 *
 * Adds Claude Code-style background task support to pi:
 *   - bash_background: run a shell command without blocking the conversation,
 *     returns a task ID and output file path immediately.
 *   - task_output: read a task's output (optionally blocking until it finishes).
 *   - task_stop: kill a running task (process tree on Windows via taskkill).
 *   - task_list: list all tasks with status.
 *   - /tasks command + widget: human-facing task overview.
 *   - Completion notifications: when a task exits, a message is injected into
 *     the conversation (steer while streaming, triggerTurn when idle) so the
 *     model reports the result on its next turn.
 *
 * Output is streamed to a file in the OS temp dir; the LLM can also read the
 * file directly with the `read` tool. Output is capped (50MB) to protect disk.
 *
 * Tasks are session-scoped: they live in memory and are killed on session
 * shutdown. Output files persist in the temp dir until cleaned by the OS.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Box, Text } from "@earendil-works/pi-tui";
import { spawn, execSync, type ChildProcess } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024; // 50MB cap per task
const NOTIFICATION_TAIL_BYTES = 2048; // output tail included in completion notification
const DEFAULT_TAIL_BYTES = 4096; // default tail returned by task_output
const OUTPUT_DIR = join(tmpdir(), "pi-background-tasks");

type TaskStatus = "running" | "completed" | "failed" | "stopped";

interface BgTask {
	id: string;
	command: string;
	description?: string;
	pid: number | undefined;
	startedAt: number;
	finishedAt?: number;
	exitCode: number | null;
	status: TaskStatus;
	outputFile: string;
	child?: ChildProcess;
	truncated: boolean;
	notified: boolean;
	stopRequested: boolean;
	waiters: Array<() => void>;
	timeoutTimer?: NodeJS.Timeout;
}

function humanDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	const m = Math.floor(ms / 60_000);
	const s = Math.round((ms % 60_000) / 1000);
	return `${m}m${s}s`;
}

function statusIcon(status: TaskStatus): string {
	switch (status) {
		case "running":
			return "▶";
		case "completed":
			return "✔";
		case "stopped":
			return "■";
		case "failed":
			return "✘";
	}
}

export default function (pi: ExtensionAPI) {
	const tasks = new Map<string, BgTask>();
	let lastCtx: ExtensionContext | undefined;

	function running(): BgTask[] {
		return [...tasks.values()].filter((t) => t.status === "running");
	}

	async function tailOfFile(path: string, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
		let fh: Awaited<ReturnType<typeof open>> | undefined;
		try {
			fh = await open(path, "r");
			const size = (await fh.stat()).size;
			const start = Math.max(0, size - maxBytes);
			const len = size - start;
			const buf = Buffer.alloc(len);
			await fh.read(buf, 0, len, start);
			return { text: buf.toString("utf8"), truncated: start > 0 };
		} catch {
			return { text: "", truncated: false };
		} finally {
			await fh?.close();
		}
	}

	function updateWidget(ctx: ExtensionContext | undefined) {
		if (!ctx?.hasUI) return;
		const runningTasks = running();
		if (runningTasks.length === 0) {
			ctx.ui.setWidget("background-tasks", undefined);
			ctx.ui.setStatus("background-tasks", undefined);
			return;
		}
		const lines = runningTasks.slice(0, 6).map((t) => {
			const label = t.description ? `${t.description} (${t.command})` : t.command;
			const since = new Date(t.startedAt).toLocaleTimeString();
			return `${statusIcon("running")} ${t.id} ${label} — running since ${since}`;
		});
		if (runningTasks.length > 6) lines.push(`  … and ${runningTasks.length - 6} more`);
		ctx.ui.setWidget("background-tasks", lines);
		ctx.ui.setStatus("background-tasks", `${runningTasks.length} background task(s) — /tasks`);
	}

	function taskLabel(t: BgTask): string {
		return t.description ? `"${t.description}" (${t.command})` : t.command;
	}

	function notifyCompletion(task: BgTask) {
		if (task.notified) return;
		task.notified = true;
		void (async () => {
			const { text } = await tailOfFile(task.outputFile, NOTIFICATION_TAIL_BYTES);
			const duration = humanDuration((task.finishedAt ?? Date.now()) - task.startedAt);
			const exit = task.exitCode === null ? "no exit code" : `exit code ${task.exitCode}`;
			const header = `Background task ${task.id} ${statusIcon(task.status)} ${task.status} (${exit}, ${duration}): ${taskLabel(task)}`;
			const tail = text.trim() ? `\n\nLast output:\n${text}` : "\n\n(no output)";
			pi.sendMessage(
				{
					customType: "background-tasks",
					content: `${header}${tail}`,
					display: true,
					details: {
						taskId: task.id,
						status: task.status,
						exitCode: task.exitCode,
						outputFile: task.outputFile,
					},
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
		})();
	}

	function startTask(command: string, description: string | undefined, timeoutMs: number | undefined, ctx: ExtensionContext): BgTask {
		const id = randomUUID().slice(0, 8);
		const outputFile = join(OUTPUT_DIR, `${id}.log`);
		const child = spawn(command, {
			shell: true,
			cwd: ctx.cwd,
			env: { ...process.env, PI_BG_TASK_ID: id },
			stdio: ["ignore", "pipe", "pipe"],
		});

		const task: BgTask = {
			id,
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
		};
		tasks.set(id, task);

		let bytes = 0;
		const out = createWriteStream(outputFile, { flags: "a" });
		const onData = (chunk: Buffer) => {
			if (task.truncated) return;
			if (bytes + chunk.length > MAX_OUTPUT_BYTES) {
				task.truncated = true;
				out.end(`\n[pi background-tasks] output limit (${Math.floor(MAX_OUTPUT_BYTES / 1024 / 1024)}MB) reached; further output discarded. The process keeps running; use task_output for status.\n`);
				return;
			}
			bytes += chunk.length;
			out.write(chunk);
		};
		child.stdout?.on("data", onData);
		child.stderr?.on("data", onData);

		if (timeoutMs && timeoutMs > 0) {
			task.timeoutTimer = setTimeout(() => {
				void stopTask(task);
			}, timeoutMs);
			task.timeoutTimer.unref?.();
		}

		child.on("close", (code) => {
			if (task.timeoutTimer) clearTimeout(task.timeoutTimer);
			task.finishedAt = Date.now();
			task.exitCode = code;
			if (task.status === "running") {
				task.status = task.stopRequested ? "stopped" : code === 0 ? "completed" : "failed";
			}
			if (!out.writableEnded) out.end();
			notifyCompletion(task);
			for (const w of task.waiters) w();
			task.waiters = [];
			updateWidget(lastCtx);
		});

		child.on("error", (err) => {
			// Spawn itself failed (e.g. shell not found); surface as failed task.
			if (task.status === "running") {
				task.finishedAt = Date.now();
				task.status = "failed";
				task.exitCode = null;
				out.end(`\n[pi background-tasks] failed to start: ${err.message}\n`);
				notifyCompletion(task);
				for (const w of task.waiters) w();
				task.waiters = [];
				updateWidget(lastCtx);
			}
		});

		return task;
	}

	async function stopTask(task: BgTask): Promise<void> {
		if (task.status !== "running") return;
		task.stopRequested = true;
		if (process.platform === "win32") {
			if (task.pid) {
				// Kill the whole process tree (shell + children, e.g. dev servers).
				try {
					execSync(`taskkill /pid ${task.pid} /T /F`, { stdio: "ignore" });
				} catch {
					task.child?.kill("SIGKILL");
				}
			} else {
				task.child?.kill("SIGKILL");
			}
		} else {
			task.child?.kill("SIGTERM");
			const killer = setTimeout(() => task.child?.kill("SIGKILL"), 5000);
			killer.unref?.();
		}
	}

	function waitFor(task: BgTask, timeoutMs: number): Promise<boolean> {
		if (task.status !== "running") return Promise.resolve(true);
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			timer.unref?.();
			task.waiters.push(() => {
				clearTimeout(timer);
				resolve(true);
			});
		});
	}

	function formatTask(t: BgTask, tailBytes = 0): string {
		const duration = humanDuration((t.finishedAt ?? Date.now()) - t.startedAt);
		const exit = t.exitCode === null ? "" : `, exit ${t.exitCode}`;
		const parts = [`${statusIcon(t.status)} ${t.id} ${t.status} (${duration}${exit}) ${taskLabel(t)}`];
		parts.push(`   output file: ${t.outputFile}${t.truncated ? " (output was truncated at 50MB)" : ""}`);
		return parts.join("\n");
	}

	// Track a context so child-process callbacks can update the widget.
	pi.on("session_start", (_event, ctx) => {
		lastCtx = ctx;
	});

	// Kill everything when the session shuts down (mirrors Claude Code cleanup).
	pi.on("session_shutdown", async () => {
		for (const t of running()) {
			void stopTask(t);
		}
	});

	pi.registerTool({
		name: "bash_background",
		label: "Background Bash",
		description:
			"Run a shell command in the background without blocking. Returns a task ID and output file path immediately. " +
			"Use for long-running processes: dev servers, builds, watchers, test suites, installs. " +
			"Retrieve output later with task_output (use block:true to wait for completion) or by reading the output file.",
		promptSnippet: "Run a shell command in the background, returns a task ID immediately",
		promptGuidelines: [
			"Use bash_background for long-running commands (dev servers, builds, watchers, test suites) so you can keep working while they run; retrieve results with task_output or by reading the returned output file.",
		],
		parameters: Type.Object({
			command: Type.String({ description: "The shell command to run" }),
			description: Type.Optional(Type.String({ description: "Short human-readable label for this task" })),
			timeout_ms: Type.Optional(Type.Number({ description: "Automatically stop the task after this many milliseconds" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			await mkdir(OUTPUT_DIR, { recursive: true });
			const task = startTask(params.command, params.description, params.timeout_ms, ctx);
			updateWidget(ctx);
			return {
				content: [
					{
						type: "text",
						text: `Started background task ${task.id}\nCommand: ${task.command}\nOutput file: ${task.outputFile}\n\nUse task_output with task_id "${task.id}" to check on it (block:true waits for completion), or read the output file directly.`,
					},
				],
				details: { taskId: task.id, outputFile: task.outputFile, pid: task.pid },
			};
		},
	});

	pi.registerTool({
		name: "task_output",
		label: "Task Output",
		description:
			"Get the status and output of a background task. Set block:true to wait for completion (up to timeout_ms, default 30s). " +
			"Returns the last tail_bytes of output (default 4096) plus status, exit code and duration.",
		promptSnippet: "Check status/output of a background task; can block until it finishes",
		promptGuidelines: [
			"Use task_output with block:true to wait for a background task to finish instead of repeatedly polling with short tails.",
		],
		parameters: Type.Object({
			task_id: Type.String({ description: "The task ID returned by bash_background" }),
			block: Type.Optional(Type.Boolean({ description: "Wait for the task to finish before returning (default false)" })),
			timeout_ms: Type.Optional(Type.Number({ description: "Max time to wait when blocking (default 30000)" })),
			tail_bytes: Type.Optional(Type.Number({ description: "How many bytes of output tail to return (default 4096)" })),
		}),
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = tasks.get(params.task_id);
			if (!task) {
				throw new Error(`Unknown task ID: ${params.task_id}. Use task_list to see known tasks.`);
			}
			if (params.block && task.status === "running") {
				const completed = await waitFor(task, params.timeout_ms ?? 30_000);
				if (!completed && task.status === "running") {
					signal?.throwIfAborted?.();
				}
			}
			const { text, truncated } = await tailOfFile(task.outputFile, params.tail_bytes ?? DEFAULT_TAIL_BYTES);
			const duration = humanDuration((task.finishedAt ?? Date.now()) - task.startedAt);
			const statusLine = `${statusIcon(task.status)} ${task.status} (${duration}${task.exitCode === null ? "" : `, exit ${task.exitCode}`})`;
			const body = text.trim()
				? `${statusLine}\n\n${truncated ? "[...earlier output omitted...]\n" : ""}${text}`
				: `${statusLine}\n\n(no output yet)`;
			return {
				content: [{ type: "text", text: body }],
				details: {
					taskId: task.id,
					status: task.status,
					exitCode: task.exitCode,
					durationMs: (task.finishedAt ?? Date.now()) - task.startedAt,
					outputFile: task.outputFile,
				},
			};
		},
	});

	pi.registerTool({
		name: "task_stop",
		label: "Stop Task",
		description: "Stop a running background task. Kills the entire process tree.",
		promptSnippet: "Stop a running background task",
		parameters: Type.Object({
			task_id: Type.String({ description: "The task ID returned by bash_background" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const task = tasks.get(params.task_id);
			if (!task) {
				throw new Error(`Unknown task ID: ${params.task_id}. Use task_list to see known tasks.`);
			}
			if (task.status !== "running") {
				return {
					content: [{ type: "text", text: `Task ${task.id} already finished: ${task.status}` }],
					details: { taskId: task.id, status: task.status },
				};
			}
			await stopTask(task);
			return {
				content: [{ type: "text", text: `Stopping task ${task.id} (${task.command}). Use task_output to confirm it exited.` }],
				details: { taskId: task.id },
			};
		},
	});

	pi.registerTool({
		name: "task_list",
		label: "List Tasks",
		description: "List all background tasks from this session with status, exit codes and output file paths.",
		promptSnippet: "List background tasks and their statuses",
		parameters: Type.Object({}),
		async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			if (tasks.size === 0) {
				return { content: [{ type: "text", text: "No background tasks have been started this session." }], details: { tasks: [] } };
			}
			const text = [...tasks.values()].map((t) => formatTask(t)).join("\n");
			return {
				content: [{ type: "text", text }],
				details: { tasks: [...tasks.values()].map((t) => ({ id: t.id, status: t.status, exitCode: t.exitCode })) },
			};
		},
	});

	pi.registerCommand("tasks", {
		description: "List background tasks (running and finished)",
		handler: async (_args, ctx) => {
			if (tasks.size === 0) {
				ctx.ui.notify("No background tasks this session.", "info");
				return;
			}
			const lines = [...tasks.values()].map((t) => formatTask(t));
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});

	// Pretty rendering for completion notifications.
	pi.registerMessageRenderer("background-tasks", (message, { expanded, outputPad }, theme) => {
		const details = message.details as
			| { taskId?: string; status?: string; exitCode?: number | null; outputFile?: string }
			| undefined;
		const status = details?.status ?? "completed";
		const color = status === "completed" ? "success" : status === "stopped" ? "warning" : "error";
		const firstLine = (message.content ?? "").split("\n")[0];
		const box = new Box(outputPad, 1, (t) => theme.bg("customMessageBg", t));
		box.addChild(new Text(`${theme.fg(color, statusIcon(status as TaskStatus))} ${firstLine}`, 0, 0));
		if (expanded && details?.outputFile) {
			box.addChild(new Text(theme.fg("dim", `  output: ${details.outputFile}`), 0, 0));
		}
		return box;
	});
}
