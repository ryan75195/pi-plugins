/**
 * Shared harness for the goal plugin contract tests.
 *
 * Drives the real GoalPlugin factory with a fake opencode SDK client and
 * records every observable side effect (dispatched prompts, evaluator child
 * sessions, evaluator prompts) so tests can assert on plugin behaviour
 * without a running opencode instance.
 */
import { GoalPlugin } from "../goal.ts"
import { rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { CapturedPart } from "./pushedPrompts.ts"

export const GOAL_STATE_DIR = join(tmpdir(), "opencode-goal")
export const BACKGROUND_TASKS_STATE_FILE = join(tmpdir(), "opencode-background-tasks", "state.json")

/** The plugin persists to and reads well-known tmpdir paths; start each test from a clean slate. */
export function resetStateDirs(): void {
	rmSync(GOAL_STATE_DIR, { recursive: true, force: true })
	rmSync(join(tmpdir(), "opencode-background-tasks"), { recursive: true, force: true })
}

/** Seed the shared background-tasks state file so `backgroundWorkRunning` sees a running task. */
export function seedRunningBackgroundTask(sessionID: string): void {
	mkdirSync(join(tmpdir(), "opencode-background-tasks"), { recursive: true })
	writeFileSync(
		BACKGROUND_TASKS_STATE_FILE,
		JSON.stringify({ updatedAt: Date.now(), tasks: [{ id: "bg-seeded", sessionID, status: "running" }] }),
	)
}

export interface Harness {
	plugin: any
	calls: {
		/** Every promptAsync push, with the raw parts so metadata markers stay observable. */
		dispatched: Array<{ sessionID: string; text: string; parts: CapturedPart[] }>
		evaluatorSessions: string[]
		evaluatorPrompts: string[]
	}
}

export interface HarnessOptions {
	/** Verdict lines returned by the evaluator child session, in order; the last one repeats. */
	verdicts?: string[]
	/** Rows returned by session.messages (the transcript the evaluator and no-tool check see). */
	transcript?: unknown[]
}

export const DEFAULT_VERDICT = "NOT_MET: the condition is not satisfied yet"

export async function makeHarness(options: HarnessOptions = {}): Promise<Harness> {
	resetStateDirs()
	const calls = {
		dispatched: [] as Array<{ sessionID: string; text: string; parts: CapturedPart[] }>,
		evaluatorSessions: [] as string[],
		evaluatorPrompts: [] as string[],
	}
	const verdictQueue = [...(options.verdicts ?? [])]
	let childCounter = 0
	const client: any = {
		config: { get: async () => ({ data: {} }) },
		tui: { showToast: async () => ({}) },
		session: {
			create: async (request: any) => {
				calls.evaluatorSessions.push(request?.body?.title ?? "")
				childCounter += 1
				return { data: { id: `eval-child-${childCounter}` } }
			},
			delete: async () => ({}),
			messages: async () => ({ data: options.transcript ?? [] }),
			prompt: async (request: any) => {
				calls.evaluatorPrompts.push((request?.body?.parts ?? []).map((p: any) => p?.text ?? "").join("\n"))
				const reply = verdictQueue.length > 0 ? verdictQueue.shift() : (options.verdicts?.[options.verdicts.length - 1] ?? DEFAULT_VERDICT)
				return { data: { parts: [{ type: "text", text: reply }] } }
			},
			promptAsync: async (request: any) => {
				const parts = (request?.body?.parts ?? []) as CapturedPart[]
				const text = parts
					.filter((p: any) => p?.type === "text")
					.map((p: any) => p.text)
					.join("\n")
				calls.dispatched.push({ sessionID: request?.path?.id, text, parts })
				return {}
			},
		},
	}
	const plugin: any = await GoalPlugin({ client, directory: "/work/repo" })
	return { plugin, calls }
}

/** Drain the event loop (including the plugin's fire-and-forget work and its real fs writes). */
export async function settle(turns = 30): Promise<void> {
	for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve))
}

/** Fire a session.idle event the way opencode does when a turn finishes, then let the plugin settle. */
export async function turnFinished(plugin: any, sessionID: string): Promise<void> {
	await plugin.event({ event: { type: "session.idle", properties: { sessionID } } })
	await settle()
}

/** Invoke a tool's execute the way opencode would. */
export async function runTool(plugin: any, name: string, args: any, sessionID: string): Promise<string> {
	const output = await plugin.tool[name].execute(args, { sessionID, directory: "/work/repo" })
	return typeof output === "string" ? output : String(output)
}

/**
 * Dispatched prompts that actually re-run the loop prompt. Iteration
 * dispatches carry the prompt as a plain instruction; plugin-generated
 * notices are "◎"-marked per this repo's convention (goal.ts, monitor.ts) and
 * never count as runs.
 */
export function runsOf(harness: Harness, prompt: string): Array<{ sessionID: string; text: string }> {
	return harness.calls.dispatched.filter((d) => d.text.includes(prompt) && !d.text.trimStart().startsWith("◎"))
}
