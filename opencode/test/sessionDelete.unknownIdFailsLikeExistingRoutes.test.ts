import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

test("deleting an unknown session id fails exactly like the existing per-id session routes do", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_still_there", title: "untouched" }],
  })

  const viaAbort = await instance.request("POST", "/session/ses_never_existed/abort")
  assert.equal(viaAbort.status, 404)
  const abortBody = await viaAbort.json()

  const viaDelete = await instance.request("DELETE", "/session/ses_never_existed")
  assert.equal(viaDelete.status, viaAbort.status)
  assert.deepEqual(await viaDelete.json(), abortBody)

  assert.notDeepEqual(abortBody, { error: "not found" })
  assert.equal(instance.fake.hasSession("ses_still_there"), true)
})
