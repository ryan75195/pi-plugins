import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

test("a delete request without valid token auth is rejected exactly like every other route", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_guarded", title: "guarded" }],
  })

  const listingWithoutToken = await instance.request("GET", "/session", { token: null })
  assert.equal(listingWithoutToken.status, 401)
  const rejectionBody = await listingWithoutToken.json()

  const deleteWithoutToken = await instance.request("DELETE", "/session/ses_guarded", { token: null })
  assert.equal(deleteWithoutToken.status, listingWithoutToken.status)
  assert.deepEqual(await deleteWithoutToken.json(), rejectionBody)

  const deleteWithWrongToken = await instance.request("DELETE", "/session/ses_guarded", {
    token: "not-the-instance-token",
  })
  assert.equal(deleteWithWrongToken.status, listingWithoutToken.status)
  assert.deepEqual(await deleteWithWrongToken.json(), rejectionBody)

  const deleteWithValidToken = await instance.request("DELETE", "/session/ses_guarded")
  assert.notEqual(deleteWithValidToken.status, 401)
})
