import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeOpencode, type FakeMessageRow } from "./fakeOpencode.ts"

type RemoteControlModule = typeof import("../../plugins/remote-control.ts")

let modulePromise: Promise<RemoteControlModule> | undefined

async function loadModule(): Promise<RemoteControlModule> {
  if (!modulePromise) {
    const sandbox = mkdtempSync(join(tmpdir(), "remote-control-contract-"))
    process.env.TEMP = sandbox
    process.env.HOME = join(sandbox, "home")
    mkdirSync(process.env.HOME, { recursive: true })
    modulePromise = import("../../plugins/remote-control.ts")
  }
  return modulePromise
}

export type CallOptions = { token?: string | null; body?: unknown }

export type TestInstance = {
  directory: string
  token: string
  fake: ReturnType<typeof createFakeOpencode>
  request: (method: string, path: string, options?: CallOptions) => Promise<Response>
}

export async function openTestInstance(
  seed: {
    sessions?: Array<{ id: string; title: string }>
    messages?: Record<string, FakeMessageRow[]>
  } = {},
): Promise<TestInstance> {
  const mod = await loadModule()
  const directory = `/work/contract-${Math.random().toString(36).slice(2, 8)}`
  const token = `inst-${Math.random().toString(36).slice(2, 12)}`
  const fake = createFakeOpencode({ directory, sessions: seed.sessions, messages: seed.messages })
  const hooks = await mod.RemoteControlPlugin({
    client: fake.client,
    project: { id: "contract" },
    directory,
    worktree: directory,
    experimental_workspace: { register: () => {} },
    serverUrl: new URL("http://127.0.0.1:9"),
    $: {},
  } as unknown as Parameters<typeof mod.RemoteControlPlugin>[0])
  fake.onSessionEvent((event) => {
    void hooks.event?.({ event: event as never })
  })
  const handle = mod.makeInstanceRouteHandler({
    client: fake.client,
    directory,
    token,
    getState: () => undefined,
    listSessions: async () => {
      throw new Error("the web-page /api/* surface is outside this contract")
    },
    messagesOf: async () => {
      throw new Error("the web-page /api/* surface is outside this contract")
    },
    questionProxy: async () => {
      throw new Error("question routes are outside this contract")
    },
  })
  const request = async (method: string, path: string, options: CallOptions = {}): Promise<Response> => {
    const headers: Record<string, string> = {}
    if (options.token !== null) headers["x-oc-token"] = options.token ?? token
    const init: { method: string; headers: Record<string, string>; body?: string } = { method, headers }
    if (options.body !== undefined) {
      headers["content-type"] = "application/json"
      init.body = JSON.stringify(options.body)
    }
    return handle(new Request(`http://instance.test${path}`, init))
  }
  return { directory, token, fake, request }
}
