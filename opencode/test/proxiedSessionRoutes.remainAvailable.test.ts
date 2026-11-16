/**
 * Contract: the V1 REST routes native clients speak are still served, now from
 * the opencode 2 plugin context, with V2 data mapped back to the V1 shapes.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

test("listing sessions answers V1 session objects", async () => {
  const instance = await openTestInstance({
    sessions: [
      { id: "ses_alpha", title: "alpha" },
      { id: "ses_beta", title: "beta" },
    ],
  })

  const res = await instance.request("GET", "/session")
  assert.equal(res.status, 200)
  const rows = (await res.json()) as Array<{ id: string; title: string; directory: string; time: { created: number; updated: number } }>
  assert.deepEqual(
    rows.map((row) => row.id).sort(),
    ["ses_alpha", "ses_beta"],
  )
  const alpha = rows.find((row) => row.id === "ses_alpha")
  assert.equal(alpha?.title, "alpha")
  assert.equal(alpha?.directory, instance.directory)
  assert.equal(typeof alpha?.time.updated, "number")
})

test("creating a session creates it in this directory and answers it", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_seed", title: "seed" }],
  })

  const res = await instance.request("POST", "/session", { body: { title: "fresh from remote" } })
  assert.equal(res.status, 200)
  const created = (await res.json()) as { id: string; title: string; directory: string }
  assert.equal(created.title, "fresh from remote")
  assert.equal(created.directory, instance.directory)
  assert.equal(instance.fake.hasSession(created.id), true)
})

test("renaming a session renames it and answers the renamed session", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_renamed", title: "old title" }],
  })

  const blank = await instance.request("PATCH", "/session/ses_renamed", { body: { title: "   " } })
  assert.equal(blank.status, 400)

  const res = await instance.request("PATCH", "/session/ses_renamed", { body: { title: "renamed from the phone" } })
  assert.equal(res.status, 200)
  assert.equal(((await res.json()) as { title: string }).title, "renamed from the phone")
  assert.equal(instance.fake.sessionTitle("ses_renamed"), "renamed from the phone")
})

test("reading a session's messages answers V1 { info, parts } rows", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_transcript", title: "transcript" }],
    messages: {
      ses_transcript: [
        { id: "msg_u", type: "user", time: { created: 1 }, text: "what changed today?" },
        { id: "msg_switch", type: "agent-switched", time: { created: 2 }, agent: "build" },
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 3, completed: 4 },
          agent: "build",
          model: { id: "deepseek/flash", providerID: "openrouter" },
          content: [
            { type: "text", text: "the dispatch moved" },
            {
              type: "tool",
              id: "call_1",
              name: "read",
              state: { status: "completed", input: { path: "a.ts" }, content: [{ type: "text", text: "file body" }] },
            },
          ],
        },
      ],
    },
  })

  const res = await instance.request("GET", "/session/ses_transcript/message")
  assert.equal(res.status, 200)
  const rows = (await res.json()) as Array<{
    info: { id: string; role: string; modelID?: string; providerID?: string }
    parts: Array<{ type: string; text?: string; tool?: string; state?: { status: string; output?: string } }>
  }>
  assert.deepEqual(
    rows.map((row) => row.info.role),
    ["user", "assistant"],
    "V2 bookkeeping entries (agent switches) have no V1 message and are left out",
  )
  assert.equal(rows[0]!.parts[0]!.text, "what changed today?")
  assert.equal(rows[1]!.info.modelID, "deepseek/flash")
  assert.equal(rows[1]!.info.providerID, "openrouter")
  assert.deepEqual(rows[1]!.parts.map((p) => p.type), ["text", "tool"])
  assert.equal(rows[1]!.parts[1]!.tool, "read")
  assert.deepEqual(rows[1]!.parts[1]!.state && { status: rows[1]!.parts[1]!.state.status, output: rows[1]!.parts[1]!.state.output }, {
    status: "completed",
    output: "file body",
  })

  const limited = await instance.request("GET", "/session/ses_transcript/message?limit=1")
  assert.deepEqual(((await limited.json()) as Array<{ info: { id: string } }>).map((r) => r.info.id), ["msg_a"])
})

test("the web page's transcript is one { role, text } per message", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_web", title: "web" }],
    messages: {
      ses_web: [
        { id: "msg_u", type: "user", time: { created: 1 }, text: "hello" },
        {
          id: "msg_a",
          type: "assistant",
          time: { created: 2 },
          agent: "build",
          model: { id: "m", providerID: "p" },
          content: [
            { type: "text", text: "hi" },
            { type: "tool", id: "c", name: "shell", state: { status: "running", input: {} } },
          ],
        },
      ],
    },
  })

  const res = await instance.request("GET", "/api/messages?session=ses_web")
  assert.equal(res.status, 200)
  assert.deepEqual(await res.json(), [
    { role: "user", text: "hello" },
    { role: "assistant", text: "hi\n[shell running]" },
  ])
})

test("prompting a session sends the V1 parts as one V2 prompt", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_prompted", title: "prompted" }],
  })

  const res = await instance.request("POST", "/session/ses_prompted/prompt_async", {
    body: {
      parts: [
        { type: "text", text: "run the smoke test" },
        { type: "file", mime: "image/png", url: "data:image/png;base64,AAAA", filename: "shot.png" },
        { type: "bogus", text: "dropped" },
      ],
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.prompts, [
    { sessionID: "ses_prompted", text: "run the smoke test", files: [{ uri: "data:image/png;base64,AAAA", name: "shot.png" }] },
  ])
  assert.deepEqual(instance.fake.switches, [], "no selector, no switch")

  const empty = await instance.request("POST", "/session/ses_prompted/prompt_async", { body: { parts: [] } })
  assert.equal(empty.status, 400)
})

test("a prompt's model and agent selectors switch the session before it is prompted", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_picked", title: "picked" }],
  })

  const res = await instance.request("POST", "/session/ses_picked/prompt_async", {
    body: {
      parts: [{ type: "text", text: "go" }],
      model: { providerID: "openrouter", modelID: "deepseek/flash" },
      agent: "explore",
    },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.switches, [
    { sessionID: "ses_picked", agent: "explore" },
    { sessionID: "ses_picked", model: { id: "deepseek/flash", providerID: "openrouter" } },
  ])
  assert.deepEqual(instance.fake.callNames().slice(-3), ["session.switchAgent", "session.switchModel", "session.prompt"])
})

test("aborting a session interrupts it", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_running", title: "running" }],
  })

  const res = await instance.request("POST", "/session/ses_running/abort")
  assert.equal(res.status, 200)
  assert.equal(await res.json(), true)
  assert.deepEqual(instance.fake.interrupted, ["ses_running"])
})

test("running a command runs it by name with its arguments as the text", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_commanded", title: "commanded" }],
  })

  const res = await instance.request("POST", "/session/ses_commanded/command", {
    body: { command: "optimize", arguments: "fast", model: "openrouter/deepseek/flash" },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.commands, [{ sessionID: "ses_commanded", name: "optimize", text: "fast" }])
  assert.deepEqual(instance.fake.switches, [
    { sessionID: "ses_commanded", model: { id: "deepseek/flash", providerID: "openrouter" } },
  ])
})

test("answering a permission request replies with the V1 response as the decision", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_gated", title: "gated" }],
  })

  const res = await instance.request("POST", "/session/ses_gated/permissions/perm_write", {
    body: { response: "once" },
  })
  assert.equal(res.status, 200)
  assert.deepEqual(instance.fake.permissionReplies, [
    { sessionID: "ses_gated", requestID: "perm_write", decision: "once" },
  ])

  const bad = await instance.request("POST", "/session/ses_gated/permissions/perm_write", { body: { response: "maybe" } })
  assert.equal(bad.status, 400)
})

test("the agent, command and provider catalogues answer in V1 shape", async () => {
  const instance = await openTestInstance()

  const agents = (await (await instance.request("GET", "/agent")).json()) as Array<{ name: string; mode: string; model?: unknown }>
  assert.deepEqual(agents.map((a) => a.name), ["build", "explore"], "V1 addressed agents by what V2 calls the id")
  assert.deepEqual(agents[0]!.model, { providerID: "openrouter", modelID: "deepseek/flash" })

  const commands = (await (await instance.request("GET", "/command")).json()) as Array<{ name: string; description: string }>
  assert.deepEqual(commands.map((c) => c.name), ["remote-control"])
  assert.equal(commands[0]!.description, "Toggle Remote Control")

  const providers = (await (await instance.request("GET", "/config/providers")).json()) as {
    providers: Array<{ id: string; models: Record<string, { id: string; providerID: string }> }>
    default: Record<string, string>
  }
  assert.deepEqual(providers.providers.map((p) => p.id), ["openrouter"], "a provider without models is left out")
  assert.deepEqual(Object.keys(providers.providers[0]!.models).sort(), ["deepseek/flash", "deepseek/pro"])
  assert.deepEqual(providers.default, { openrouter: "deepseek/pro" })
})
