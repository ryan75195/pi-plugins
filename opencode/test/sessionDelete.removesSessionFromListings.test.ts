import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

test("an authenticated DELETE of a session id removes that session from later listings", async () => {
  const instance = await openTestInstance({
    sessions: [
      { id: "ses_lingering_mobile", title: "📱 New session" },
      { id: "ses_workstation", title: "refactor remote-control dispatch" },
    ],
  })

  const before = await instance.request("GET", "/session")
  assert.equal(before.status, 200)
  const rowsBefore = (await before.json()) as Array<{ id: string; title?: string }>
  assert.ok(
    rowsBefore.some((row) => row.id === "ses_lingering_mobile" && row.title === "📱 New session"),
    `expected the lingering mobile session in the initial listing: ${JSON.stringify(rowsBefore)}`,
  )

  const deleted = await instance.request("DELETE", "/session/ses_lingering_mobile")
  assert.equal(deleted.status, 200)

  const after = await instance.request("GET", "/session")
  assert.equal(after.status, 200)
  const rowsAfter = (await after.json()) as Array<{ id: string }>
  assert.equal(
    rowsAfter.some((row) => row.id === "ses_lingering_mobile"),
    false,
    `expected the deleted session to be gone from the listing: ${JSON.stringify(rowsAfter)}`,
  )
  assert.ok(
    rowsAfter.some((row) => row.id === "ses_workstation"),
    `expected unrelated sessions to survive the deletion: ${JSON.stringify(rowsAfter)}`,
  )
})
