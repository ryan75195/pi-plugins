/**
 * Contract: an authenticated POST /disconnect stops remote control for the
 * instance — the caller is answered first, the teardown runs after, and
 * unauthenticated attempts are rejected without touching the teardown.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

const SETTLE_MS = 150

test("An authenticated disconnect answers ok and runs the teardown once", async () => {
	let disconnects = 0
	const inst = await openTestInstance(
		{ sessions: [{ id: "ses_a", title: "t" }] },
		{ disconnect: () => { disconnects += 1 } },
	)
	const res = await inst.request("POST", "/disconnect")
	assert.equal(res.status, 200)
	assert.equal((await res.json()).ok, true)
	await new Promise((r) => setTimeout(r, SETTLE_MS))
	assert.equal(disconnects, 1)
})

test("Unauthenticated disconnect attempts are rejected and run no teardown", async () => {
	let disconnects = 0
	const inst = await openTestInstance({}, { disconnect: () => { disconnects += 1 } })
	const res = await inst.request("POST", "/disconnect", { token: "wrong-token" })
	assert.equal(res.status, 401)
	await new Promise((r) => setTimeout(r, SETTLE_MS))
	assert.equal(disconnects, 0)
})
