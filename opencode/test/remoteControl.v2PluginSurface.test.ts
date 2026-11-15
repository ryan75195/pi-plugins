/**
 * Contract: under the opencode 2 plugin API the file default-exports
 * `{ id, setup }`; setup registers the `remote_control` tool, pushes its
 * system-prompt guidance once per request, and relays the event subscription
 * to native clients in the V1 shape (including the session.status /
 * session.idle events V2 no longer sends itself).
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { loadModule, openTestInstance } from "./helpers/instance.ts"

test("the default export is a V2 plugin definition", async () => {
  const mod = await loadModule()
  assert.equal(mod.default.id, "remote-control")
  assert.equal(typeof mod.default.setup, "function")
})

test("setup registers the remote_control tool with the V1 arguments", async () => {
  const instance = await openTestInstance()
  const tool = instance.fake.tools.get("remote_control")
  assert.ok(tool, "remote_control is registered")
  assert.match(tool.description, /This tool backs the \/remote-control command/)
  const input = tool.input as { properties: { action: { enum: string[] }; name: { type: string } }; required: string[] }
  assert.deepEqual(input.properties.action.enum, ["toggle", "on", "off", "status", "pair", "rotate-pairing"])
  assert.equal(input.properties.name.type, "string")
  assert.deepEqual(input.required, ["action"])
})

test("the status action reports no registration without touching tailscale", async () => {
  const instance = await openTestInstance()
  const tool = instance.fake.tools.get("remote_control")!
  const result = (await tool.execute({ action: "status" }, { sessionID: "ses_x" })) as { content: string }
  assert.equal(result.content, "Remote Control: not active. Run /remote-control to register this session.")
})

test("the context hook adds the guidance once", async () => {
  const instance = await openTestInstance()
  const [hook] = instance.fake.hooks.get("context") ?? []
  assert.ok(hook, "a context hook is registered")
  const request = { system: [{ type: "text", text: "base" }] }
  await hook(request)
  await hook(request)
  const guidance = request.system.filter((p) => p.text.startsWith("Remote control (plugin primitive)"))
  assert.equal(guidance.length, 1)
  assert.match(guidance[0]!.text, /Report every URL it returns verbatim/)
})

test("a session's run reaches /event as V1 session.status and session.idle, and /session/status tracks it", async () => {
  const mod = await loadModule()
  const directory = `/work/relay-${Math.random().toString(36).slice(2, 8)}`
  const statuses = new Map<string, unknown>()
  const handle = mod.makeInstanceRouteHandler({
    api: {} as never,
    directory,
    token: "tok",
    getState: () => undefined,
    questionProxy: async () => new Response(null, { status: 502 }),
    disconnect: () => {},
    sessionStatus: () => Object.fromEntries(statuses),
  })
  const get = (path: string) => handle(new Request(`http://instance.test${path}`, { headers: { "x-oc-token": "tok" } }))
  const stream = await get("/event")
  const reader = (stream.body as ReadableStream<Uint8Array>).getReader()
  const decoder = new TextDecoder()

  mod.relayInstanceEvent(directory, { id: "e1", type: "session.execution.started", data: { sessionID: "ses_r" } }, statuses)
  assert.deepEqual(await (await get("/session/status")).json(), { ses_r: { type: "busy" } })
  mod.relayInstanceEvent(directory, { id: "e2", type: "session.text.ended", data: { sessionID: "ses_r" }, location: { directory: "/elsewhere" } }, statuses)
  mod.relayInstanceEvent(directory, { id: "e3", type: "session.execution.succeeded", data: { sessionID: "ses_r" } }, statuses)
  assert.deepEqual(await (await get("/session/status")).json(), {})

  let text = ""
  while ((text.match(/^data: /gm) ?? []).length < 6) {
    const chunk = await reader.read()
    if (chunk.done) break
    text += decoder.decode(chunk.value, { stream: true })
  }
  await reader.cancel()
  const payloads = text
    .split("\n")
    .filter((line) => line.startsWith("data: "))
    .map((line) => (JSON.parse(line.slice(6)) as { payload: { type: string; properties: unknown } }).payload)
  assert.deepEqual(payloads, [
    { type: "server.connected", properties: {} },
    { type: "session.execution.started", properties: { sessionID: "ses_r" } },
    { type: "session.status", properties: { sessionID: "ses_r", status: { type: "busy" } } },
    { type: "session.execution.succeeded", properties: { sessionID: "ses_r" } },
    { type: "session.status", properties: { sessionID: "ses_r", status: { type: "idle" } } },
    { type: "session.idle", properties: { sessionID: "ses_r" } },
  ], "another directory's event is not forwarded")
})
