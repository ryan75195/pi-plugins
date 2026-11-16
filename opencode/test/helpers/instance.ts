import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createFakeOpencode, type FakeMessage } from "./fakeOpencode.ts"

type RemoteControlModule = typeof import("../../plugins/remote-control.ts")

let modulePromise: Promise<RemoteControlModule> | undefined

export async function loadModule(): Promise<RemoteControlModule> {
  if (!modulePromise) {
    const sandbox = mkdtempSync(join(tmpdir(), "remote-control-contract-"))
    process.env.TEMP = sandbox
    process.env.HOME = join(sandbox, "home")
    // Node reads the home directory from USERPROFILE on Windows: without this the
    // machine pairing and resume files would be the real ones under ~/.config.
    process.env.USERPROFILE = process.env.HOME
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
  close: () => Promise<void>
}

/**
 * Boots the plugin's V2 `setup` against a fake plugin context (so its tool,
 * hooks and event subscription are live) and serves the instance routes from
 * the same fake, without the tailscale "on" path.
 */
export async function openTestInstance(
  seed: {
    sessions?: Array<{ id: string; title: string; directory?: string }>
    messages?: Record<string, FakeMessage[]>
  } = {},
  options: { disconnect?: () => void } = {},
): Promise<TestInstance> {
  const mod = await loadModule()
  const directory = `/work/contract-${Math.random().toString(36).slice(2, 8)}`
  const token = `inst-${Math.random().toString(36).slice(2, 12)}`
  const fake = createFakeOpencode({ directory, sessions: seed.sessions, messages: seed.messages })
  const cleanup = await mod.default.setup(fake.ctx as unknown as Parameters<RemoteControlModule["default"]["setup"]>[0])
  const handle = mod.makeInstanceRouteHandler({
    api: fake.ctx as unknown as Parameters<RemoteControlModule["makeInstanceRouteHandler"]>[0]["api"],
    directory,
    token,
    getState: () => undefined,
    questionProxy: async () => {
      throw new Error("question routes are outside this contract")
    },
    disconnect: options.disconnect ?? (() => {}),
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
  return {
    directory,
    token,
    fake,
    request,
    close: async () => {
      if (typeof cleanup === "function") await cleanup()
    },
  }
}
