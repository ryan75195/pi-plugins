/**
 * Contract: concurrent instance processes rewrite the shared registration
 * file without losing each other's entries. Mutations run inside a
 * cross-process lock, registrations whose pid is gone are pruned on every
 * write, a held lock makes a writer back off without clobbering, and a stale
 * lock from a crashed process is stolen instead of blocking forever.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

type RemoteControlModule = typeof import("../../plugins/remote-control.ts")

const sandbox = mkdtempSync(join(tmpdir(), "remote-control-state-"))
process.env.TEMP = sandbox
const STATE_DIR = join(sandbox, "opencode-remote")
const STATE_FILE = join(STATE_DIR, "state.json")
const LOCK_FILE = join(STATE_DIR, "state.lock")

const mod: RemoteControlModule = await import("../plugins/remote-control.ts")

function seedState(registrations: Array<Record<string, unknown>>): void {
	mkdirSync(STATE_DIR, { recursive: true })
	writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: Date.now(), registrations }, null, 2))
}

function registrations(): Array<Record<string, unknown>> {
	return JSON.parse(readFileSync(STATE_FILE, "utf8")).registrations
}

function spawnLingerChild(): Promise<{ pid: number; wait: () => Promise<void> }> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 10_000)"], { stdio: "ignore" })
		child.on("spawn", () => resolve({
			pid: child.pid!,
			wait: () =>
				new Promise((done) => {
					child.on("exit", () => done(undefined))
					child.kill()
				}),
		}))
		child.on("error", reject)
	})
}

test("An update from one instance preserves another live instance's entry", async () => {
	const child = await spawnLingerChild()
	seedState([{ id: "other", pid: child.pid, clients: 1 }])
	mod.updateRegistrations((regs) => [...regs, { id: "own", pid: process.pid, clients: 0 }])
	const held = registrations()
	assert.equal(held.length, 2)
	assert.deepEqual(held.map((r) => r.id).sort(), ["other", "own"])
	assert.equal(held.find((r) => r.id === "other")?.clients, 1)
	await child.wait()
})

test("A registration whose pid is gone is pruned on the next write", async () => {
	const child = await spawnLingerChild()
	seedState([
		{ id: "doomed", pid: child.pid, clients: 1 },
		{ id: "own", pid: process.pid, clients: 0 },
	])
	await child.wait()
	mod.updateRegistrations((regs) => regs)
	const held = registrations()
	assert.deepEqual(held.map((r) => r.id), ["own"])
})

test("A live holder's lock makes the writer back off without touching the file", async () => {
	seedState([{ id: "before", pid: process.pid }])
	mkdirSync(STATE_DIR, { recursive: true })
	const holder = spawn(
		process.execPath,
		["-e", `const fs = require("node:fs"); const f = ${JSON.stringify(LOCK_FILE)}; const tick = () => fs.writeFileSync(f, process.pid + " " + Date.now()); tick(); const iv = setInterval(tick, 100); setTimeout(() => { clearInterval(iv); process.exit(0); }, 3500);`],
		{ stdio: "ignore" }
	)
	const lockAppeared = await new Promise<boolean>((resolve) => {
		const started = Date.now()
		const poll = () => {
			if (existsSync(LOCK_FILE)) return resolve(true)
			if (Date.now() - started > 2_000) return resolve(false)
			setTimeout(poll, 20)
		}
		poll()
	})
	assert.equal(lockAppeared, true)
	mod.updateRegistrations((regs) => [...regs, { id: "dropped", pid: process.pid }])
	assert.deepEqual(registrations().map((r) => r.id), ["before"])
	await new Promise((done) => {
		holder.on("exit", () => done(undefined))
	})
})

test("A stale lock from a crashed process is stolen and the write lands", () => {
	seedState([{ id: "before", pid: process.pid }])
	writeFileSync(LOCK_FILE, `999999 ${Date.now() - 10_000}`)
	mod.updateRegistrations((regs) => [...regs, { id: "after", pid: process.pid }])
	assert.deepEqual(registrations().map((r) => r.id).sort(), ["after", "before"])
	assert.equal(existsSync(LOCK_FILE), false)
})
