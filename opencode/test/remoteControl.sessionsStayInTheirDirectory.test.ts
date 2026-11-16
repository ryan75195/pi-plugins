/**
 * Contract: under opencode 2 one process hosts every directory and sessions are
 * addressed by id alone, so an instance's routes must refuse a session that lives
 * in another directory — answering exactly as for an unknown id — instead of
 * letting one instance's token read or drive another project's sessions.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

const FOREIGN = { id: "ses_other_project", title: "elsewhere", directory: "/work/another-project" }

test("every per-session route answers 404 for a session in another directory and leaves it alone", async () => {
  const instance = await openTestInstance({ sessions: [{ id: "ses_mine", title: "mine" }, FOREIGN] })
  const id = FOREIGN.id
  const calls: Array<[string, string, unknown?]> = [
    ["GET", `/session/${id}/message`],
    ["PATCH", `/session/${id}`, { title: "hijacked" }],
    ["DELETE", `/session/${id}`],
    ["POST", `/session/${id}/prompt_async`, { parts: [{ type: "text", text: "hi" }] }],
    ["POST", `/session/${id}/abort`],
    ["POST", `/session/${id}/command`, { command: "init", arguments: "" }],
    ["POST", `/session/${id}/permissions/per_1`, { response: "once" }],
    ["GET", `/api/messages?session=${id}`],
    ["POST", "/api/send", { session: id, text: "hi" }],
  ]
  for (const [method, path, body] of calls) {
    const res = await instance.request(method, path, body === undefined ? {} : { body })
    assert.equal(res.status, 404, `${method} ${path}`)
    assert.equal(((await res.json()) as { name?: string }).name, "Session.NotFoundError", `${method} ${path}`)
  }
  assert.equal(instance.fake.sessionTitle(id), "elsewhere", "not renamed")
  assert.equal(instance.fake.hasSession(id), true, "not deleted")
  assert.deepEqual(instance.fake.prompts, [])
  assert.deepEqual(instance.fake.commands, [])
  assert.deepEqual(instance.fake.interrupted, [])
  assert.deepEqual(instance.fake.permissionReplies, [])
  await instance.close()
})

test("a foreign session answers like an unknown one", async () => {
  const instance = await openTestInstance({ sessions: [FOREIGN] })
  const foreign = await instance.request("POST", `/session/${FOREIGN.id}/abort`)
  const unknown = await instance.request("POST", "/session/ses_never_existed/abort")
  assert.equal(foreign.status, unknown.status)
  assert.equal(((await foreign.json()) as { name: string }).name, ((await unknown.json()) as { name: string }).name)
  await instance.close()
})

test("this directory's own sessions still work through the same routes", async () => {
  const instance = await openTestInstance({ sessions: [{ id: "ses_mine", title: "mine" }, FOREIGN] })
  const res = await instance.request("POST", "/api/send", { body: { session: "ses_mine", text: "hello" } })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.prompts, [{ sessionID: "ses_mine", text: "hello" }])
  const listed = (await (await instance.request("GET", "/session")).json()) as Array<{ id: string }>
  assert.deepEqual(listed.map((s) => s.id), ["ses_mine"])
  await instance.close()
})
