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
import { DynamicBorder } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import { Container, Key, matchesKey, SelectList, Text, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
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

interface UiTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const PANEL_FINISHED_LINGER_MS = 60_000; // finished tasks stay in the panel this long
const OUTPUT_VIEW_LINES = 20; // visible lines in the output viewer

function spinnerFrame(): string {
	return SPINNER_FRAMES[Math.floor(Date.now() / 90) % SPINNER_FRAMES.length];
}

function statusColor(status: TaskStatus): string {
	switch (status) {
		case "running":
			return "accent";
		case "completed":
			return "success";
		case "stopped":
			return "warning";
		case "failed":
			return "error";
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

	function sortedTasks(): BgTask[] {
		return [...tasks.values()].sort((a, b) => {
			if (a.status === "running" && b.status !== "running") return -1;
			if (a.status !== "running" && b.status === "running") return 1;
			return (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt);
		});
	}

	let panelTui: { requestRender(): void } | undefined;
	let panelTicker: NodeJS.Timeout | undefined;

	function stopPanelTicker() {
		if (panelTicker) {
			clearInterval(panelTicker);
			panelTicker = undefined;
		}
	}

	function startPanelTicker() {
		if (panelTicker) return;
		panelTicker = setInterval(() => {
			const runningTasks = running();
			if (runningTasks.length > 0) {
				// Keep elapsed times spinning while tasks are live.
				panelTui?.requestRender();
				return;
			}
			// Nothing running: clear the panel once the last finished task has lingered long enough.
			const lastFinished = Math.max(...[...tasks.values()].map((t) => t.finishedAt ?? 0));
			if (Date.now() - lastFinished > PANEL_FINISHED_LINGER_MS) {
				if (lastCtx?.hasUI) {
					lastCtx.ui.setWidget("background-tasks", undefined);
					lastCtx.ui.setStatus("background-tasks", undefined);
				}
				stopPanelTicker();
			}
		}, 500);
		panelTicker.unref?.();
	}

	function renderTaskRow(t: BgTask, width: number, theme: UiTheme): string {
		const icon = t.status === "running" ? spinnerFrame() : statusIcon(t.status);
		const right =
			t.status === "running"
				? humanDuration(Date.now() - t.startedAt)
				: `${humanDuration((t.finishedAt ?? Date.now()) - t.startedAt)}${t.exitCode === null ? "" : ` · exit ${t.exitCode}`}`;
		const maxLeft = Math.max(1, width - visibleWidth(right) - 2);
		let left = `${icon} ${t.id} ${taskLabel(t)}`;
		if (visibleWidth(left) > maxLeft) left = truncateToWidth(left, maxLeft);
		const pad = " ".repeat(Math.max(1, width - visibleWidth(left) - visibleWidth(right)));
		return theme.fg(statusColor(t.status), left + pad + right);
	}

	function taskPanelComponent(theme: UiTheme) {
		return {
			render(width: number): string[] {
				const list = sortedTasks();
				const lines: string[] = [];
				const runningCount = list.filter((t) => t.status === "running").length;
				const header =
					runningCount > 0
						? `${spinnerFrame()} ${runningCount} background task${runningCount === 1 ? "" : "s"} running · /tasks for details`
						: `background tasks · /tasks for details`;
				lines.push(theme.fg("dim", truncateToWidth(header, width)));
				for (const t of list.slice(0, 8)) {
					lines.push(renderTaskRow(t, width, theme));
				}
				if (list.length > 8) lines.push(theme.fg("dim", `  … +${list.length - 8} more`));
				return lines;
			},
			invalidate() {},
		};
	}

	function updateWidget(ctx: ExtensionContext | undefined) {
		if (!ctx?.hasUI) return;
		if (tasks.size === 0) {
			ctx.ui.setWidget("background-tasks", undefined);
			ctx.ui.setStatus("background-tasks", undefined);
			stopPanelTicker();
			return;
		}
		startPanelTicker();
		ctx.ui.setWidget(
			"background-tasks",
			(tui, theme) => {
				panelTui = tui;
				return taskPanelComponent(theme);
			},
			{ placement: "belowEditor" },
		);
		const runningCount = running().length;
		ctx.ui.setStatus(
			"background-tasks",
			runningCount > 0 ? `${runningCount} background task${runningCount === 1 ? "" : "s"} — /tasks` : undefined,
		);
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

	function taskPicker(ctx: ExtensionContext, title: string, items: Array<{ value: string; label: string; description?: string }>): Promise<string | null> {
		return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));
			const list = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (t) => theme.fg("accent", t),
				selectedText: (t) => theme.fg("accent", t),
				description: (t) => theme.fg("muted", t),
				scrollInfo: (t) => theme.fg("dim", t),
				noMatch: (t) => theme.fg("warning", t),
			});
			list.onSelect = (item) => done(item.value);
			list.onCancel = () => done(null);
			container.addChild(list);
			container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			return {
				render: (w) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					list.handleInput(data);
					tui.requestRender();
				},
			};
		});
	}

	function taskDescription(t: BgTask): string {
		const duration = humanDuration((t.finishedAt ?? Date.now()) - t.startedAt);
		const exit = t.exitCode === null ? "" : ` · exit ${t.exitCode}`;
		const started = new Date(t.startedAt).toLocaleTimeString();
		return `${t.status} · ${duration}${exit} · started ${started}`;
	}

	async function showOutputViewer(ctx: ExtensionContext, task: BgTask): Promise<void> {
		const { text, truncated } = await tailOfFile(task.outputFile, 256 * 1024);
		const lines = text.split("\n");
		const total = lines.length;
		let offset = 0; // lines scrolled up from the bottom (tail)
		const maxOffset = Math.max(0, total - OUTPUT_VIEW_LINES);
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const header = new Text("", 1, 0);
			const body = new Text("", 0, 0);
			const draw = (width: number) => {
				const from = Math.max(0, total - OUTPUT_VIEW_LINES - offset);
				const to = total - offset;
				const visible = lines.slice(from, to);
				header.setText(theme.fg("accent", theme.bold(`Output · ${task.id} ${task.command}`)));
				const rendered = visible.map((l) => truncateToWidth(l.replace(/\t/g, "    "), width));
				const hasContent = rendered.some((l) => l.trim().length > 0);
				body.setText(hasContent ? rendered.join("\n") : theme.fg("dim", "(no output yet)"));
			};
			const container = new Container();
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			container.addChild(header);
			container.addChild(body);
			container.addChild(new Text(theme.fg("dim", `↑↓ scroll · ←→ page · esc close${truncated ? " · (older output omitted, full file on disk)" : ""}`), 1, 0));
			container.addChild(new DynamicBorder((s) => theme.fg("accent", s)));
			return {
				render: (w) => {
					draw(w);
					return container.render(w);
				},
				invalidate: () => container.invalidate(),
				handleInput: (data) => {
					if (matchesKey(data, Key.escape) || data === "q") {
						done();
						return;
					}
					if (matchesKey(data, Key.up)) offset = Math.min(offset + 1, maxOffset);
					else if (matchesKey(data, Key.down)) offset = Math.max(0, offset - 1);
					else if (matchesKey(data, Key.left)) offset = Math.min(offset + OUTPUT_VIEW_LINES, maxOffset);
					else if (matchesKey(data, Key.right)) offset = Math.max(0, offset - OUTPUT_VIEW_LINES);
					else return;
					tui.requestRender();
				},
			};
		}, { overlay: true });
	}

	pi.registerCommand("tasks", {
		description: "Manage background tasks (view output, stop)",
		handler: async (_args, ctx) => {
			if (tasks.size === 0) {
				ctx.ui.notify("No background tasks this session.", "info");
				return;
			}
			if (ctx.mode !== "tui") {
				// Non-interactive fallback: plain text listing.
				const lines = [...tasks.values()].map((t) => formatTask(t));
				ctx.ui.notify(lines.join("\n"), "info");
				return;
			}
			for (;;) {
				const list = sortedTasks();
				if (list.length === 0) {
					ctx.ui.notify("No background tasks this session.", "info");
					return;
				}
				const items = list.map((t) => ({
					value: t.id,
					label: `${statusIcon(t.status)} ${t.id}  ${taskLabel(t)}`,
					description: taskDescription(t),
				}));
				items.push({ value: "__close", label: "Close", description: "Exit the task manager" });
				const picked = await taskPicker(ctx, "Background tasks", items);
				if (!picked || picked === "__close") return;
				const task = tasks.get(picked);
				if (!task) continue;
				for (;;) {
					const actions: Array<{ value: string; label: string; description?: string }> = [
						{ value: "view", label: "View output", description: `${task.outputFile}${task.truncated ? " (truncated at 50MB)" : ""}` },
					];
					if (task.status === "running") {
						actions.push({ value: "stop", label: "Stop task", description: "Kill the process tree" });
					}
					actions.push({ value: "back", label: "Back", description: "Return to the task list" });
					const action = await taskPicker(ctx, `Task ${task.id} — ${task.status}`, actions);
					if (!action || action === "back") break;
					if (action === "view") {
						await showOutputViewer(ctx, task);
					} else if (action === "stop") {
						void stopTask(task);
						ctx.ui.notify(`Stopping ${task.id}…`, "info");
					}
				}
			}
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
