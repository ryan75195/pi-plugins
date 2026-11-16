/**
 * A fake opencode 2.3 (V2) plugin context, for driving a `Plugin.define`
 * plugin's real `setup` without a running opencode.
 *
 * It records the tools the plugin adds through `tool.transform`, the hooks it
 * registers, and every synthetic message it queues into a session, and lets a
 * test push events into the stream `event.subscribe` returns.
 */

export interface SyntheticCall {
	sessionID: string
	text: string
	description?: string | null
	metadata?: Record<string, unknown>
	delivery?: string | null
	resume?: boolean | null
}

export interface FakeTool {
	name: string
	description: string
	input: any
	options?: { codemode?: boolean; permission?: string }
	execute: (input: unknown, context: any) => Promise<{ content?: unknown }>
}

export interface V2Harness {
	tools: Map<string, FakeTool>
	/** Every name passed to `add`, duplicates included. */
	added: string[]
	hooks: Map<string, Array<(input: any) => unknown>>
	synthetic: SyntheticCall[]
	cleanup: (() => Promise<void> | void) | undefined
	/** Deliver an event to every active `event.subscribe` stream. */
	emit(event: { type: string; data: Record<string, unknown> }): void
	/** Call a registered tool the way opencode does, returning its text. */
	run(name: string, input: unknown, sessionID: string): Promise<string>
	/** Run the session `context` hooks over a system prompt and return its texts. */
	context(system?: string[]): Promise<string[]>
}

/**
 * `builtins` stand in for opencode's own tools (e.g. its `shell`): they are in
 * the editor before the plugin's transform runs, as in a real opencode.
 */
export async function loadV2(
	plugin: { id: string; setup: (ctx: any) => any },
	directory = process.cwd(),
	builtins: FakeTool[] = [],
): Promise<V2Harness> {
	const tools = new Map<string, FakeTool>(builtins.map((tool) => [tool.name, tool]))
	const added: string[] = []
	const hooks = new Map<string, Array<(input: any) => unknown>>()
	const synthetic: SyntheticCall[] = []
	const subscribers = new Set<(event: any) => void>()

	const registration = { dispose: async () => {} }
	const addHook = async (name: string, callback: (input: any) => unknown) => {
		hooks.set(name, [...(hooks.get(name) ?? []), callback])
		return registration
	}

	const ctx = {
		location: { directory, project: { id: "global", directory, canonical: directory } },
		session: {
			hook: addHook,
			synthetic: async (input: SyntheticCall) => {
				synthetic.push(input)
				return { id: `msg_${synthetic.length}`, sessionID: input.sessionID, type: "synthetic" }
			},
		},
		tool: {
			hook: addHook,
			transform: async (callback: (editor: any) => void) => {
				callback({
					add: (tool: FakeTool) => {
						added.push(tool.name)
						tools.set(tool.name, tool)
					},
					get: (id: string) => tools.get(id),
					list: () => [...tools.values()],
					update: () => {},
					remove: (id: string) => tools.delete(id),
					namespace: () => {},
				})
				return registration
			},
		},
		event: {
			subscribe: (options?: { types?: string[]; signal?: AbortSignal }) => {
				const queue: any[] = []
				let wake: (() => void) | undefined
				const push = (event: any) => {
					if (options?.types && !options.types.includes(event.type)) return
					queue.push(event)
					wake?.()
				}
				subscribers.add(push)
				return {
					async *[Symbol.asyncIterator]() {
						try {
							while (!options?.signal?.aborted) {
								if (queue.length === 0) {
									await new Promise<void>((resolve) => {
										wake = resolve
										options?.signal?.addEventListener("abort", () => resolve(), { once: true })
									})
									wake = undefined
									continue
								}
								yield queue.shift()
							}
						} finally {
							subscribers.delete(push)
						}
					},
				}
			},
		},
	}

	const cleanup = (await plugin.setup(ctx)) ?? undefined
	return {
		tools,
		added,
		hooks,
		synthetic,
		cleanup,
		emit(event) {
			for (const push of subscribers) push(event)
		},
		async run(name, input, sessionID) {
			const tool = tools.get(name)
			if (!tool) throw new Error(`no tool ${name}`)
			const controller = new AbortController()
			const result = await tool.execute(input, { sessionID, agent: "build", messageID: "msg_test", id: "call_test", signal: controller.signal, progress: async () => {} })
			return typeof result.content === "string" ? result.content : JSON.stringify(result.content)
		},
		async context(system = []) {
			const request = { system: system.map((text) => ({ type: "text", text })), tools: {}, messages: [], options: {} }
			for (const hook of hooks.get("context") ?? []) await hook(request)
			return request.system.map((p) => p.text)
		},
	}
}

/** Wait until `check` passes, polling the event loop (real processes run underneath). */
export async function waitUntil(check: () => boolean, timeoutMs = 15_000): Promise<void> {
	const deadline = Date.now() + timeoutMs
	while (!check()) {
		if (Date.now() > deadline) throw new Error("timed out waiting for the condition")
		await new Promise((resolve) => setTimeout(resolve, 50))
	}
}
