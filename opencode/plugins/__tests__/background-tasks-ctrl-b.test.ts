/**
 * Contract: ctrl+b in the TUI moves a blocking `bash` command to the background,
 * end to end. While the command blocks, the shared state file carries it in the
 * shape the TUI acts on (foreground, not backgrounded, running, live pid); the
 * TUI's request (`backgroundSessions` in requests.json) makes the waiting tool
 * call return at once with the task id; the task carries on in the background and
 * its result arrives later as a queued notice. Several directories' setups in one
 * process share the files without dropping each other's rows or requests.
 *
 * TEMP is pointed at a sandbox before the plugin loads, so the real opencode's
 * state and request files are never touched.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const sandbox = mkdtempSync(join(tmpdir(), "bg-tasks-ctrl-b-"))
process.env.TEMP = sandbox
process.env.TMP = sandbox
process.env.TMPDIR = sandbox

const { default: plugin } = await import("../background-tasks.ts")
const { loadV2, waitUntil } = await import("./v2-harness.ts")

const DIR = join(sandbox, "opencode-background-tasks")
const STATE_FILE = join(DIR, "state.json")
const REQUESTS_FILE = join(DIR, "requests.json")

type Row = { id: string; sessionID: string; foreground?: boolean; backgrounded?: boolean; status: string; pid?: number }

function rows(): Row[] {
	try {
		return (JSON.parse(readFileSync(STATE_FILE, "utf8")) as { tasks: Row[] }).tasks
	} catch {
		return []
	}
}

function requests(): { stop?: string[]; backgroundSessions?: string[] } {
	return existsSync(REQUESTS_FILE) ? JSON.parse(readFileSync(REQUESTS_FILE, "utf8")) : {}
}

/** What the TUI's ctrl+b writes (background-tasks-sidebar `requestBackgroundSession`). */
function pressCtrlB(sessionID: string): void {
	const current = requests()
	writeFileSync(REQUESTS_FILE, JSON.stringify({ ...current, backgroundSessions: [...new Set([...(current.backgroundSessions ?? []), sessionID])] }))
}

/** The TUI's test for "a command is blocking this session" (foregroundForSession). */
function blocking(sessionID: string): Row | undefined {
	return rows().find((t) => t.sessionID === sessionID && t.foreground && !t.backgrounded && t.status === "running" && typeof t.pid === "number")
}

const slow = (marker: string, ms: number) => `node -e "setTimeout(() => console.log('${marker}'), ${ms})"`

test("ctrl+b moves a blocking bash command to the background and the tool call returns", async () => {
	const h = await loadV2(plugin, process.cwd())
	try {
		const call = h.run("bash", { command: slow("LATE_DONE", 2500) }, "ses_ctrlb")
		await waitUntil(() => blocking("ses_ctrlb") !== undefined, 10_000)
		const row = blocking("ses_ctrlb")!
		assert.equal(row.status, "running")

		pressCtrlB("ses_ctrlb")
		const result = await call
		assert.match(result, new RegExp(`^Command moved to background by the user \\(task ${row.id}, pid \\d+\\)\\.`))
		assert.match(result, /A message with the command's full result will be sent to you when it finishes\./)
		assert.deepEqual(requests().backgroundSessions, [], "the request is consumed")

		const after = rows().find((t) => t.id === row.id)
		assert.equal(after?.backgrounded, true, "the state file shows it backgrounded (the sidebar's row)")
		assert.equal(blocking("ses_ctrlb"), undefined, "nothing blocks the session any more")

		await waitUntil(() => h.synthetic.length > 0, 15_000)
		assert.equal(h.synthetic[0]!.sessionID, "ses_ctrlb")
		assert.match(h.synthetic[0]!.text, new RegExp(`^Background task ${row.id} ✔ completed \\(exit code 0, `))
		assert.match(h.synthetic[0]!.text, /LATE_DONE/)
	} finally {
		await h.cleanup?.()
	}
})

test("a foreground command that finishes while blocking leaves the state file and sends no notice", async () => {
	const h = await loadV2(plugin, process.cwd())
	try {
		const out = await h.run("bash", { command: slow("QUICK", 300) }, "ses_quick")
		assert.equal(out.trim(), "QUICK")
		await new Promise((resolve) => setTimeout(resolve, 100))
		assert.deepEqual(rows().filter((t) => t.sessionID === "ses_quick"), [])
		assert.equal(h.synthetic.length, 0)
	} finally {
		await h.cleanup?.()
	}
})

test("two directories' setups keep each other's rows, and each consumes only its own ctrl+b", async () => {
	const a = await loadV2(plugin, process.cwd())
	const b = await loadV2(plugin, process.cwd())
	try {
		const callA = a.run("bash", { command: slow("A_DONE", 2500) }, "ses_dir_a")
		const callB = b.run("bash", { command: slow("B_DONE", 2500) }, "ses_dir_b")
		await waitUntil(() => blocking("ses_dir_a") !== undefined && blocking("ses_dir_b") !== undefined, 10_000)

		pressCtrlB("ses_dir_b")
		assert.match(await callB, /^Command moved to background by the user/)
		assert.ok(blocking("ses_dir_a"), "A's blocking row survives B's writes")
		assert.deepEqual(requests().backgroundSessions, [])

		pressCtrlB("ses_dir_a")
		assert.match(await callA, /^Command moved to background by the user/)
		await waitUntil(() => a.synthetic.length > 0 && b.synthetic.length > 0, 15_000)
		assert.match(a.synthetic[0]!.text, /A_DONE/)
		assert.match(b.synthetic[0]!.text, /B_DONE/)
	} finally {
		await a.cleanup?.()
		await b.cleanup?.()
	}
})

test("a request for a session this setup doesn't know is left for its owner", async () => {
	const h = await loadV2(plugin, process.cwd())
	try {
		const call = h.run("bash", { command: slow("MINE", 1500) }, "ses_mine")
		await waitUntil(() => blocking("ses_mine") !== undefined, 10_000)
		pressCtrlB("ses_someone_else")
		assert.equal((await call).trim(), "MINE", "its own command is not backgrounded")
		assert.deepEqual(requests().backgroundSessions, ["ses_someone_else"])
	} finally {
		writeFileSync(REQUESTS_FILE, JSON.stringify({}))
		await h.cleanup?.()
	}
})

test("the replacement bash carries the shell permission, so rules that deny shell hide it too", async () => {
	const h = await loadV2(plugin, process.cwd())
	try {
		assert.deepEqual(h.tools.get("bash")?.options, { codemode: false, permission: "shell" })
	} finally {
		await h.cleanup?.()
	}
})
