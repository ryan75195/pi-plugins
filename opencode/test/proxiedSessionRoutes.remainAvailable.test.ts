import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

test("listing sessions still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [
      { id: "ses_alpha", title: "alpha" },
      { id: "ses_beta", title: "beta" },
    ],
  })

  const res = await instance.request("GET", "/session")
  assert.equal(res.status, 200)
  const rows = (await res.json()) as Array<{ id: string }>
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    ["ses_alpha", "ses_beta"],
  )
})

test("creating a session still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_seed", title: "seed" }],
  })

  const res = await instance.request("POST", "/session", { body: { title: "fresh from remote" } })
  assert.equal(res.status, 200)
  const created = (await res.json()) as { id: string; title: string }
  assert.equal(created.title, "fresh from remote")
  assert.equal(instance.fake.hasSession(created.id), true)
})

test("renaming a session still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_renamed", title: "old title" }],
  })

  const blank = await instance.request("PATCH", "/session/ses_renamed", { body: { title: "   " } })
  assert.equal(blank.status, 400)

  const res = await instance.request("PATCH", "/session/ses_renamed", { body: { title: "renamed from the phone" } })
  assert.equal(res.status, 200)
  assert.equal(instance.fake.sessionTitle("ses_renamed"), "renamed from the phone")
})

test("reading a session's messages still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_transcript", title: "transcript" }],
    messages: {
      ses_transcript: [
        { info: { role: "user" }, parts: [{ type: "text", text: "what changed today?" }] },
        { info: { role: "assistant" }, parts: [{ type: "text", text: "the dispatch moved" }] },
      ],
    },
  })

  const res = await instance.request("GET", "/session/ses_transcript/message")
  assert.equal(res.status, 200)
  const rows = (await res.json()) as Array<{ info: { role: string }; parts: Array<{ type: string; text?: string }> }>
  assert.deepEqual(
    rows.map((row) => row.info.role),
    ["user", "assistant"],
  )
  assert.equal(rows[0].parts[0].text, "what changed today?")
})

test("prompting a session still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_prompted", title: "prompted" }],
  })

  const res = await instance.request("POST", "/session/ses_prompted/prompt_async", {
    body: { parts: [{ type: "text", text: "run the smoke test" }] },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.prompts, [
    { id: "ses_prompted", body: { parts: [{ type: "text", text: "run the smoke test" }] } },
  ])
})

test("aborting a session still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_running", title: "running" }],
  })

  const res = await instance.request("POST", "/session/ses_running/abort")
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.aborted, ["ses_running"])
})

test("running a command still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_commanded", title: "commanded" }],
  })

  const res = await instance.request("POST", "/session/ses_commanded/command", {
    body: { command: "optimize", arguments: "fast" },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.commands, [
    { id: "ses_commanded", body: { command: "optimize", arguments: "fast" } },
  ])
})

test("answering a permission request still proxies to opencode", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_gated", title: "gated" }],
  })

  const res = await instance.request("POST", "/session/ses_gated/permissions/perm_write", {
    body: { response: "once" },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.permissionReplies, [
    { id: "ses_gated", permissionID: "perm_write", response: "once" },
  ])
})
