/**
 * Contract: opencode 2.3 runs one `opencode serve --service` process for every
 * directory the TUI opens, and the plugin's setup runs once per directory. Remote
 * Control is per directory: each gets its own server, mount and registration
 * (keyed by pid + directory); on/off/unload in one never touch another; the hub
 * goes only with the last one; and a restart resumes every directory that was on.
 *
 * Bun.serve and the tailscale CLI are stood in for through `remoteControlHost`,
 * so nothing here touches the real tailnet.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { loadModule } from "./helpers/instance.ts"
import { createFakeOpencode } from "./helpers/fakeOpencode.ts"

type RemoteControlModule = Awaited<ReturnType<typeof loadModule>>
type SetupContext = Parameters<RemoteControlModule["default"]["setup"]>[0]
type FakeServer = { port: number; stopped: boolean; fetch: (req: Request) => Response | Promise<Response> }

const mod = await loadModule()
const servers: FakeServer[] = []
const tailscaleCalls: string[][] = []
let nextPort = 9100
mod.remoteControlHost.serve = (options) => {
  const server: FakeServer = { port: options.port, stopped: false, fetch: options.fetch }
  servers.push(server)
  return { stop: () => void (server.stopped = true) }
}
mod.remoteControlHost.freePort = () => nextPort++
mod.remoteControlHost.machineHost = () => "box.tail.ts.net"
mod.remoteControlHost.tailscale = (args) => {
  tailscaleCalls.push(args)
  return { ok: true, out: args.includes("status") ? "{}" : "" }
}

const HUB_PORT = 8579
const hub = () => servers.filter((s) => s.port === HUB_PORT)
const running = () => servers.filter((s) => s.port !== HUB_PORT && !s.stopped)

type Registration = { pid: number; directory: string; mount: string; port: number; url: string }
function registrations(): Registration[] {
  return JSON.parse(readFileSync(join(process.env.TEMP!, "opencode-remote", "state.json"), "utf8")).registrations
}

async function openDirectory(name: string) {
  const directory = `/work/many-${name}-${Math.random().toString(36).slice(2, 8)}`
  const fake = createFakeOpencode({ directory, sessions: [{ id: `ses_${name}`, title: name }] })
  const cleanup = await mod.default.setup(fake.ctx as unknown as SetupContext)
  const tool = fake.tools.get("remote_control")!
  const run = async (action: string) =>
    ((await tool.execute({ action }, { sessionID: `ses_${name}` })) as { content: string }).content
  return { directory, run, unload: async () => cleanup?.() }
}

function serverFor(url: string): FakeServer {
  const reg = registrations().find((r) => r.url === url)
  assert.ok(reg, `a registration for ${url}`)
  const server = servers.find((s) => s.port === reg.port && !s.stopped)
  assert.ok(server, `a running server on ${reg.port}`)
  return server
}

const urlOf = (text: string) => text.match(/https:\/\/\S+/)![0]

test("two directories in one process each get their own registration, and off in one leaves the other", async () => {
  const a = await openDirectory("a")
  const b = await openDirectory("b")
  const onA = await a.run("on")
  const onB = await b.run("on")
  assert.match(onA, /Remote Control is ON/)
  assert.match(onB, /Remote Control is ON/, "B is not told A's server is already active")
  assert.notEqual(urlOf(onA), urlOf(onB))

  const mine = registrations().filter((r) => r.pid === process.pid)
  assert.deepEqual(mine.map((r) => r.directory).sort(), [a.directory, b.directory].sort())
  const [regA, regB] = [a, b].map((d) => mine.find((r) => r.directory === d.directory)!)
  assert.notEqual(regA!.port, regB!.port)
  assert.notEqual(regA!.mount, regB!.mount)

  assert.match(await b.run("status"), new RegExp(`\\(this directory\\)[^\\n]*\\n  URL: ${urlOf(onB).replace(/[?]/g, "\\?")}`))
  assert.match(await a.run("on"), new RegExp(`already active for this directory\\.\\nURL: ${urlOf(onA).replace(/[?]/g, "\\?")}`))

  tailscaleCalls.length = 0
  assert.equal(await b.run("off"), "Remote Control off. Local session unaffected.")
  assert.deepEqual(tailscaleCalls.filter((c) => c.includes("off")), [["serve", "--set-path", regB!.mount, "off"]], "only B's mount comes down")
  assert.deepEqual(registrations().filter((r) => r.pid === process.pid).map((r) => r.directory), [a.directory])
  assert.ok(serverFor(urlOf(onA)), "A's server keeps running")
  assert.equal(hub().some((s) => !s.stopped), true, "the hub stays while A is on")
  assert.equal(await b.run("off"), "Remote Control was not active for this directory.")

  // Off in A, the last directory on, takes the hub down too.
  assert.equal(await a.run("off"), "Remote Control off. Local session unaffected.")
  assert.deepEqual(registrations().filter((r) => r.pid === process.pid), [])
  assert.equal(hub().every((s) => s.stopped), true, "the hub goes with the last directory")
  assert.deepEqual(running(), [])
  await a.unload()
  await b.unload()
})

test("one directory's unload leaves another directory's Remote Control running", async () => {
  const a = await openDirectory("ua")
  const b = await openDirectory("ub")
  const onA = await a.run("on")
  await b.run("on")
  await b.unload()
  assert.ok(serverFor(urlOf(onA)), "A's server survives B's unload")
  assert.deepEqual(registrations().filter((r) => r.pid === process.pid).map((r) => r.directory), [a.directory])
  assert.equal(hub().some((s) => !s.stopped), true)
  assert.equal(await a.run("off"), "Remote Control off. Local session unaffected.")
  await a.unload()
})

test("a disconnect through one directory's routes stops only that directory", async () => {
  const a = await openDirectory("da")
  const b = await openDirectory("db")
  const onA = await a.run("on")
  const onB = await b.run("on")
  const serverB = serverFor(urlOf(onB))
  const res = await serverB.fetch(new Request(`http://127.0.0.1/disconnect?t=${new URL(urlOf(onB)).searchParams.get("t")}`, { method: "POST" }))
  assert.equal(res.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 200))
  assert.equal(serverB.stopped, true)
  assert.ok(serverFor(urlOf(onA)))
  assert.equal(await a.run("off"), "Remote Control off. Local session unaffected.")
  await a.unload()
  await b.unload()
})

test("after a restart every directory that was on resumes, not only the first", async () => {
  const a = await openDirectory("ra")
  const b = await openDirectory("rb")
  await a.run("on")
  await b.run("on")
  // Unload (as a service shutdown does) keeps the resume entries.
  await a.unload()
  await b.unload()
  assert.deepEqual(running(), [])

  const fresh = (directory: string) => createFakeOpencode({ directory })
  const cleanups = [
    await mod.default.setup(fresh(a.directory).ctx as unknown as SetupContext),
    await mod.default.setup(fresh(b.directory).ctx as unknown as SetupContext),
  ]
  for (let i = 0; i < 50 && running().length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.equal(running().length, 2, "both directories resumed")
  assert.deepEqual(registrations().filter((r) => r.pid === process.pid).map((r) => r.directory).sort(), [a.directory, b.directory].sort())
  for (const cleanup of cleanups) await cleanup?.()
})
