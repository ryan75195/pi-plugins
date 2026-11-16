/**
 * A fake of the opencode 2 (V2) plugin context: the slice remote-control.ts
 * uses (session, agent, command, provider, model, permission, event, tool,
 * location). Calls take and return V2 shapes; unknown session ids reject with
 * the tagged error the real host throws (`Session.NotFoundError`).
 */
export type FakeEvent = { type: string; data?: unknown; location?: { directory: string } }

/** A V2 SessionMessage, reduced to the fields the plugin maps. */
export type FakeMessage =
  | { id: string; type: "user"; time: { created: number }; text: string }
  | { id: string; type: "synthetic"; time: { created: number }; text: string }
  | {
      id: string
      type: "assistant"
      time: { created: number; completed?: number }
      agent: string
      model: { id: string; providerID: string }
      content: Array<
        | { type: "text"; text: string }
        | { type: "reasoning"; text: string }
        | { type: "tool"; id: string; name: string; state: { status: string; input: unknown; content?: Array<{ type: "text"; text: string }> } }
      >
    }
  | { id: string; type: "agent-switched"; time: { created: number }; agent: string }

type V2Session = {
  id: string
  projectID: string
  title: string
  time: { created: number; updated: number }
  location: { directory: string }
}

export type FakeOpencode = {
  ctx: Record<string, unknown>
  /** Registered tools, by name, after the plugin's transforms ran. */
  tools: Map<string, { description: string; input: unknown; execute: (input: unknown, context: unknown) => Promise<unknown> }>
  /** Registered `session.hook` callbacks, by hook name. */
  hooks: Map<string, Array<(input: unknown) => unknown>>
  callNames: () => string[]
  callCount: (name: string) => number
  hasSession: (id: string) => boolean
  sessionTitle: (id: string) => string | undefined
  sessionIds: () => string[]
  prompts: Array<{ sessionID: string; text: string; files?: unknown }>
  interrupted: string[]
  commands: Array<{ sessionID: string; name: string; text: string }>
  switches: Array<{ sessionID: string; agent?: string; model?: unknown }>
  permissionReplies: Array<{ sessionID: string; requestID: string; decision: string }>
  emit: (event: FakeEvent) => void
  /** End the open event stream(s), as a host restart or a dropped stream would. */
  endStreams: () => void
  /** How many times the plugin has subscribed to events. */
  subscriptions: () => number
}

class NotFound extends Error {
  readonly _tag = "Session.NotFoundError"
  readonly sessionID: string
  constructor(sessionID: string) {
    super("")
    this.sessionID = sessionID
    this.name = "Session.NotFoundError"
  }
}

export function createFakeOpencode(options: {
  directory: string
  /** `directory` places a session in another directory (the host knows it by id, but it isn't this instance's). */
  sessions?: Array<{ id: string; title: string; directory?: string }>
  messages?: Record<string, FakeMessage[]>
}): FakeOpencode {
  const { directory } = options
  const sessions = new Map<string, V2Session>()
  const messages = new Map<string, FakeMessage[]>()
  const calls: string[] = []
  const prompts: FakeOpencode["prompts"] = []
  const interrupted: string[] = []
  const commands: FakeOpencode["commands"] = []
  const switches: FakeOpencode["switches"] = []
  const permissionReplies: FakeOpencode["permissionReplies"] = []
  const tools: FakeOpencode["tools"] = new Map()
  const hooks: FakeOpencode["hooks"] = new Map()
  let clock = 1
  let createCounter = 0

  for (const s of options.sessions ?? []) {
    sessions.set(s.id, {
      id: s.id,
      projectID: "contract",
      title: s.title,
      time: { created: clock, updated: clock++ },
      location: { directory: s.directory ?? directory },
    })
  }
  for (const [id, rows] of Object.entries(options.messages ?? {})) messages.set(id, rows)

  // The event channel: emitted events queue until the plugin's subscription pulls them.
  const queue: FakeEvent[] = []
  let wake: (() => void) | undefined
  let generation = 0
  let subscribeCalls = 0
  const emit = (event: FakeEvent) => {
    queue.push(event)
    wake?.()
  }

  const call = (name: string) => calls.push(name)
  const known = (id: string): V2Session => {
    const row = sessions.get(id)
    if (!row) throw new NotFound(id)
    return row
  }
  const requireLocation = (input: { location?: { directory?: string } } | undefined) => {
    if (input?.location?.directory !== directory) {
      throw new Error(`fake opencode: expected location.directory=${directory} but got ${JSON.stringify(input?.location)}`)
    }
  }

  const ctx = {
    location: { directory, project: { id: "contract", directory, canonical: directory } },
    session: {
      list: async (input: { directory?: string; cursor?: string }) => {
        call("session.list")
        if (input?.directory !== directory) throw new Error(`fake opencode: expected directory=${directory}`)
        return {
          data: Array.from(sessions.values())
            .filter((s) => s.location.directory === directory)
            .map((s) => structuredClone(s)),
          cursor: {},
        }
      },
      get: async (input: { sessionID: string }) => {
        call("session.get")
        return structuredClone(known(input.sessionID))
      },
      create: async (input: { title?: string; location?: { directory: string } }) => {
        call("session.create")
        requireLocation(input)
        const created: V2Session = {
          id: `ses_fresh_${++createCounter}`,
          projectID: "contract",
          title: input.title ?? "",
          time: { created: clock, updated: clock++ },
          location: { directory },
        }
        sessions.set(created.id, created)
        return structuredClone(created)
      },
      update: async (input: { sessionID: string; title?: string }) => {
        call("session.update")
        const row = known(input.sessionID)
        if (input.title !== undefined) row.title = input.title
        row.time.updated = clock++
      },
      remove: async (input: { sessionID: string }) => {
        call("session.remove")
        known(input.sessionID)
        sessions.delete(input.sessionID)
        emit({ type: "session.deleted", data: { sessionID: input.sessionID } })
      },
      context: async (input: { sessionID: string }) => {
        call("session.context")
        known(input.sessionID)
        return structuredClone(messages.get(input.sessionID) ?? [])
      },
      prompt: async (input: { sessionID: string; text: string; files?: unknown }) => {
        call("session.prompt")
        known(input.sessionID)
        prompts.push({ sessionID: input.sessionID, text: input.text, ...(input.files ? { files: input.files } : {}) })
        return { id: `msg_${prompts.length}`, sessionID: input.sessionID, type: "user" }
      },
      interrupt: async (input: { sessionID: string }) => {
        call("session.interrupt")
        // Like the real host: an unknown id is not an error here, just nothing to stop.
        if (!sessions.has(input.sessionID)) return { interrupted: false }
        interrupted.push(input.sessionID)
        return { interrupted: true }
      },
      command: async (input: { sessionID: string; name: string; text: string }) => {
        call("session.command")
        known(input.sessionID)
        commands.push({ sessionID: input.sessionID, name: input.name, text: input.text })
      },
      switchAgent: async (input: { sessionID: string; agent: string }) => {
        call("session.switchAgent")
        known(input.sessionID)
        switches.push({ sessionID: input.sessionID, agent: input.agent })
      },
      switchModel: async (input: { sessionID: string; model: unknown }) => {
        call("session.switchModel")
        known(input.sessionID)
        switches.push({ sessionID: input.sessionID, model: input.model })
      },
      hook: async (name: string, callback: (input: unknown) => unknown) => {
        hooks.set(name, [...(hooks.get(name) ?? []), callback])
        return { dispose: async () => {} }
      },
    },
    permission: {
      reply: async (input: { sessionID: string; requestID: string; decision: string }) => {
        call("permission.reply")
        known(input.sessionID)
        permissionReplies.push({ sessionID: input.sessionID, requestID: input.requestID, decision: input.decision })
      },
    },
    agent: {
      list: async (input: { location?: { directory?: string } }) => {
        call("agent.list")
        requireLocation(input)
        return {
          location: { directory },
          data: [
            { id: "build", name: "Build", mode: "primary", hidden: false, model: { id: "deepseek/flash", providerID: "openrouter" } },
            { id: "explore", name: "Explore", mode: "subagent", hidden: false },
          ],
        }
      },
    },
    command: {
      list: async (input: { location?: { directory?: string } }) => {
        call("command.list")
        requireLocation(input)
        return { location: { directory }, data: [{ name: "remote-control", description: "Toggle Remote Control" }] }
      },
    },
    provider: {
      list: async (input: { location?: { directory?: string } }) => {
        call("provider.list")
        requireLocation(input)
        return {
          location: { directory },
          data: [
            { id: "openrouter", name: "OpenRouter", activation: "auto", package: "x" },
            { id: "inactive", name: "No models", activation: "disabled", package: "x" },
          ],
        }
      },
    },
    model: {
      list: async (input: { location?: { directory?: string } }) => {
        call("model.list")
        requireLocation(input)
        return {
          location: { directory },
          data: [
            { id: "deepseek/flash", modelID: "deepseek/flash", providerID: "openrouter", name: "Flash", enabled: true },
            { id: "deepseek/pro", modelID: "deepseek/pro", providerID: "openrouter", name: "Pro", enabled: true },
          ],
        }
      },
      default: async (input: { location?: { directory?: string } }) => {
        call("model.default")
        requireLocation(input)
        return { location: { directory }, data: { id: "deepseek/pro", modelID: "deepseek/pro", providerID: "openrouter" } }
      },
    },
    tool: {
      transform: async (callback: (editor: unknown) => void) => {
        callback({
          add: (tool: { name: string; description: string; input: unknown; execute: (input: unknown, context: unknown) => Promise<unknown> }) =>
            tools.set(tool.name, tool),
        })
        return { dispose: async () => {} }
      },
    },
    event: {
      subscribe: (opts?: { signal?: AbortSignal }) => {
        subscribeCalls++
        const born = generation
        return {
        async *[Symbol.asyncIterator]() {
          for (;;) {
            if (opts?.signal?.aborted || generation !== born) return
            const next = queue.shift()
            if (next) {
              yield { id: `evt_${clock++}`, created: clock, ...next }
              continue
            }
            await new Promise<void>((resolve) => {
              wake = resolve
              opts?.signal?.addEventListener("abort", () => resolve(), { once: true })
            })
            wake = undefined
          }
        },
        }
      },
    },
  }

  return {
    ctx,
    tools,
    hooks,
    callNames: () => [...calls],
    callCount: (name: string) => calls.filter((c) => c === name).length,
    hasSession: (id: string) => sessions.has(id),
    sessionTitle: (id: string) => sessions.get(id)?.title,
    sessionIds: () => Array.from(sessions.keys()),
    prompts,
    interrupted,
    commands,
    switches,
    permissionReplies,
    emit,
    endStreams: () => {
      generation++
      wake?.()
    },
    subscriptions: () => subscribeCalls,
  }
}
