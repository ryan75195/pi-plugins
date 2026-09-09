export type SdkResult = { data?: unknown; error?: unknown; response?: { status?: number } }

export type FakeEvent = { type: string; properties?: unknown }

export type FakeMessageRow = { info: { role: string }; parts: Array<{ type: string; text?: string }> }

export type FakeOpencode = {
  client: Record<string, unknown>
  callNames: () => string[]
  callCount: (name: string) => number
  hasSession: (id: string) => boolean
  sessionTitle: (id: string) => string | undefined
  sessionIds: () => string[]
  prompts: Array<{ id: string; body: unknown }>
  aborted: string[]
  commands: Array<{ id: string; body: unknown }>
  permissionReplies: Array<{ id: string; permissionID: unknown; response: unknown }>
  onSessionEvent: (listener: (event: FakeEvent) => void) => void
}

type FakeArgs = { query?: unknown; path?: unknown; body?: unknown }

export function createFakeOpencode(options: {
  directory: string
  sessions?: Array<{ id: string; title: string }>
  messages?: Record<string, FakeMessageRow[]>
}): FakeOpencode {
  const { directory } = options
  const sessions = new Map<string, { id: string; title: string; updatedAt: number }>()
  const messages = new Map<string, FakeMessageRow[]>()
  const calls: string[] = []
  const prompts: FakeOpencode["prompts"] = []
  const aborted: string[] = []
  const commands: FakeOpencode["commands"] = []
  const permissionReplies: FakeOpencode["permissionReplies"] = []
  let eventListener: ((event: FakeEvent) => void) | undefined
  let updatedAtCounter = 1
  let createCounter = 0

  for (const s of options.sessions ?? []) sessions.set(s.id, { ...s, updatedAt: updatedAtCounter++ })
  for (const [id, rows] of Object.entries(options.messages ?? {})) messages.set(id, rows)

  const requireDirectory = (query: unknown): void => {
    const dir = (query as { directory?: unknown } | undefined)?.directory
    if (dir !== directory) {
      throw new Error(`fake opencode: expected query.directory=${directory} but got ${JSON.stringify(dir)}`)
    }
  }
  const stored = (id: unknown) => {
    if (typeof id !== "string") {
      throw new Error(`fake opencode: expected path.id to be a string but got ${JSON.stringify(id)}`)
    }
    return sessions.get(id)
  }
  const unknownSession = (id: unknown): SdkResult => ({
    error: { message: `session not found: ${String(id)}` },
    response: { status: 404 },
  })
  const call = (name: string) => calls.push(name)

  const client = {
    session: {
      list: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.list")
        requireDirectory(args?.query)
        return { data: Array.from(sessions.values()) }
      },
      create: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.create")
        requireDirectory(args?.query)
        const created = {
          id: `ses_fresh_${++createCounter}`,
          title: typeof args?.body?.title === "string" ? args.body.title : "",
          updatedAt: updatedAtCounter++,
        }
        sessions.set(created.id, created)
        return { data: created }
      },
      update: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.update")
        requireDirectory(args?.query)
        const row = stored(args?.path?.id)
        if (!row) return unknownSession(args?.path?.id)
        row.title = String(args?.body?.title ?? "")
        return { data: { ...row } }
      },
      delete: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.delete")
        requireDirectory(args?.query)
        const row = stored(args?.path?.id)
        if (!row) return unknownSession(args?.path?.id)
        sessions.delete(row.id)
        eventListener?.({ type: "session.deleted", properties: { info: { id: row.id, title: row.title } } })
        return { data: true }
      },
      messages: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.messages")
        requireDirectory(args?.query)
        const id = args?.path?.id
        if (!stored(id)) return unknownSession(id)
        return { data: messages.get(id as string) ?? [] }
      },
      promptAsync: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.promptAsync")
        requireDirectory(args?.query)
        const row = stored(args?.path?.id)
        if (!row) return unknownSession(args?.path?.id)
        prompts.push({ id: row.id, body: args?.body })
        return { data: true }
      },
      abort: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.abort")
        requireDirectory(args?.query)
        const row = stored(args?.path?.id)
        if (!row) return unknownSession(args?.path?.id)
        aborted.push(row.id)
        return { data: true }
      },
      command: async (args: FakeArgs): Promise<SdkResult> => {
        call("session.command")
        requireDirectory(args?.query)
        const row = stored(args?.path?.id)
        if (!row) return unknownSession(args?.path?.id)
        commands.push({ id: row.id, body: args?.body })
        return { data: true }
      },
    },
    postSessionIdPermissionsPermissionId: async (args: FakeArgs): Promise<SdkResult> => {
      call("session.permissions")
      requireDirectory(args?.query)
      const row = stored(args?.path?.id)
      if (!row) return unknownSession(args?.path?.id)
      permissionReplies.push({
        id: row.id,
        permissionID: (args?.path as { permissionID?: unknown } | undefined)?.permissionID,
        response: (args?.body as { response?: unknown } | undefined)?.response,
      })
      return { data: true }
    },
  }

  return {
    client,
    callNames: () => [...calls],
    callCount: (name: string) => calls.filter((c) => c === name).length,
    hasSession: (id: string) => sessions.has(id),
    sessionTitle: (id: string) => sessions.get(id)?.title,
    sessionIds: () => Array.from(sessions.keys()),
    prompts,
    aborted,
    commands,
    permissionReplies,
    onSessionEvent: (listener) => {
      eventListener = listener
    },
  }
}
