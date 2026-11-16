/**
 * opencode Remote Control — Claude Code /remote-control parity over Tailscale.
 *
 * Registers the current session so it can be continued from a phone, tablet,
 * or any browser on your tailnet. The session keeps running locally; the web
 * client is just a window into it.
 *
 *   /remote-control          → register current session, print the URL
 *   /remote-control off      → unregister (removes tailscale serve + endpoint)
 *   /remote-control status   → connection state
 *   /remote-control pair     → print the machine pair URL (one-time app pairing)
 *   /remote-control rotate-pairing → mint a new pairing token
 *
 * Substrate: `tailscale serve --bg` publishes the tailnet's HTTPS endpoint for
 * this machine and proxies it to a localhost-only HTTP endpoint hosted by this
 * plugin inside the opencode server process (Bun.serve). Nothing is exposed to
 * the public internet (that would be `funnel`), and the endpoint is token
 * gated on top of tailnet scoping.
 *
 * Built against the opencode 2.3 (V2) plugin API: a default export `{ id, setup }`
 * whose `setup(ctx)` registers the tool, the system-prompt hook and the event
 * subscription. The REST surface the phone/web clients speak is still the V1
 * one: V2 sessions, messages and events are mapped to the V1 shapes at the API
 * boundary (see "V2 -> V1 shapes" below), so the clients stay unchanged.
 */
// Type-only: the runtime value `Plugin.define` is the identity function, so a plain
// `{ id, setup }` object is the same thing and the file stays loadable outside opencode
// (the contract tests import it under plain Node).
import type { Plugin } from "@opencode/plugin"
import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { homedir, hostname } from "node:os"
import { connect } from "node:net"

// opencode runs on Bun, so this global exists at runtime. Minimal ambient decl
// keeps TS happy without @types/bun.
declare const Bun: {
  serve(options: {
    hostname: string
    port: number
    idleTimeout?: number
    fetch: (req: Request) => Response | Promise<Response>
  }): { stop(closeActiveConnections?: boolean): void }
}

/**
 * opencode's local-plugin loader does not call only a file's designated `Plugin`
 * export: for a plain script it invokes every exported function as a plugin
 * factory, `fn(pluginInput, options)`, then reads hooks off whatever comes back.
 * `updateRegistrations`, `makeInstanceRouteHandler`, `openInstanceEventStream` and
 * `forwardInstanceEvent` are exported for reuse/tests, not as plugin factories, so
 * a misfired call must return an empty hooks object instead of running its real
 * logic — the caller can only be the loader.
 */
function isPluginLoaderMisfire(first: unknown, rest: unknown[]): boolean {
  if (rest.length > 0) return true
  return typeof first === "object" && first !== null && "client" in (first as Record<string, unknown>) && "directory" in (first as Record<string, unknown>)
}

const STATE_DIR = join(process.env.TEMP ?? "/tmp", "opencode-remote")
const STATE_FILE = join(STATE_DIR, "state.json")
// Append-only diagnostics: every tailscale call and every registration
// decision, so "why did my instance vanish" has an answer.
const LOG_FILE = join(STATE_DIR, "remote-control.log")
const LOG_MAX_BYTES = 512 * 1024
// Durable, machine-scoped pairing lives outside TEMP: a phone pairs once and
// keeps working across reboots and across every opencode instance.
const MACHINE_DIR = join(homedir(), ".config", "opencode", "remote-control")
const MACHINE_FILE = join(MACHINE_DIR, "machine.json")
// Remote control the user turned ON for a directory is remembered here, so a
// process restart resumes it instead of silently stranding a paired phone on a
// registration that no longer exists.
const RESUME_FILE = join(MACHINE_DIR, "resume.json")

type ResumeEntry = { name: string; defaultSession: string }

function readResume(directory: string): ResumeEntry | undefined {
  try {
    const raw = JSON.parse(readFileSync(RESUME_FILE, "utf8")) as Record<string, ResumeEntry>
    const entry = raw[directory]
    return entry && typeof entry.name === "string" && typeof entry.defaultSession === "string"
      ? entry
      : undefined
  } catch {
    return undefined
  }
}

function writeResume(directory: string, entry: ResumeEntry): void {
  try {
    mkdirSync(MACHINE_DIR, { recursive: true })
    const raw = existsSync(RESUME_FILE)
      ? (JSON.parse(readFileSync(RESUME_FILE, "utf8")) as Record<string, unknown>)
      : {}
    raw[directory] = { ...entry, updatedAt: Date.now() }
    writeFileSync(RESUME_FILE, JSON.stringify(raw, null, 2))
  } catch {
    /* resume is best effort */
  }
}

function clearResume(directory: string): void {
  try {
    if (!existsSync(RESUME_FILE)) return
    const raw = JSON.parse(readFileSync(RESUME_FILE, "utf8")) as Record<string, unknown>
    delete raw[directory]
    writeFileSync(RESUME_FILE, JSON.stringify(raw, null, 2))
  } catch {
    /* resume is best effort */
  }
}
const HUB_MOUNT = "/rc-hub"
const HUB_PORT = 8579 // fixed; instance ports start at 8580, so they never collide
const HUB_WATCHDOG_MS = 3_000
// Bun.serve closes a connection that is idle for 10 s by default, which kills
// an SSE stream before its first keepalive. 255 s is Bun's maximum; the
// keepalive below fires far more often than that anyway.
const SERVER_IDLE_TIMEOUT_S = 255
const SSE_KEEPALIVE_MS = 5_000
const BASE_PORT = 8580
const MAX_EVENTS = 400

type RemoteState = {
  id: string // stable across restarts (derived from the directory)
  url: string
  token: string
  port: number
  mount: string
  name: string
  directory: string
  host: string // tailnet DNS name of the machine
  defaultSession: string
  startedAt: number
  pid: number
  clients: number // live native /event subscribers on this instance
  updatedAt?: number
}

type SessionRow = { id: string; title?: string; updatedAt?: number }
type MessageRow = {
  info: { role: string }
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status?: string; output?: string } }>
}
type PromptModel = { providerID: string; modelID: string }
// The V1 prompt-part shapes the REST clients send (V1 @opencode-ai/sdk TextPartInput /
// FilePartInput, reduced to the fields this plugin forwards).
type TextPartInput = { type: "text"; text: string }
type FilePartInput = { type: "file"; mime: string; url: string; filename?: string }

/** The slice of the V2 plugin context the REST surface drives. */
export type RemoteControlApi = Pick<Plugin.Context, "session" | "agent" | "command" | "provider" | "model" | "permission">

// ── V2 -> V1 shapes ─────────────────────────────────────────────────────────
// opencode 2.x reshaped sessions, messages and events. The phone app and the
// web page speak the V1 REST shapes, so everything is mapped here, at the API
// boundary, and the clients stay unchanged. Inputs are read defensively: they
// come from the host, but a shape drift must cost a field, not a 500.

type Loose = Record<string, unknown>
const asLoose = (value: unknown): Loose => (typeof value === "object" && value !== null ? (value as Loose) : {})
const str = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined)
const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

export type V1Session = {
  id: string
  projectID: string
  directory: string
  parentID?: string
  title: string
  version: string
  time: { created: number; updated: number; archived?: number }
}

export function toV1Session(raw: unknown, directory: string): V1Session {
  const s = asLoose(raw)
  const time = asLoose(s.time)
  const created = num(time.created) ?? 0
  const archived = num(time.archived)
  const parentID = str(s.parentID)
  return {
    id: String(s.id),
    projectID: str(s.projectID) ?? "",
    directory,
    ...(parentID ? { parentID } : {}),
    title: str(s.title) ?? "",
    version: "2",
    time: { created, updated: num(time.updated) ?? created, ...(archived !== undefined ? { archived } : {}) },
  }
}

export type V1Part = {
  id: string
  sessionID: string
  messageID: string
  type: string
  text?: string
  synthetic?: boolean
  tool?: string
  callID?: string
  mime?: string
  url?: string
  filename?: string
  state?: { status: string; input?: unknown; output?: string; error?: string }
}
export type V1MessageRow = {
  info: {
    id: string
    sessionID: string
    role: "user" | "assistant"
    time: { created: number; completed?: number }
    agent?: string
    mode?: string
    modelID?: string
    providerID?: string
  }
  parts: V1Part[]
}

const TOOL_STATUS: Record<string, string> = { streaming: "pending", running: "running", completed: "completed", error: "error" }

function toolOutput(content: unknown): string | undefined {
  if (!Array.isArray(content)) return undefined
  const texts = content.map(asLoose).filter((c) => c.type === "text" && typeof c.text === "string").map((c) => c.text as string)
  return texts.length > 0 ? texts.join("\n") : undefined
}

/**
 * One V2 SessionMessage as a V1 `{ info, parts }` row, or undefined for the V2
 * bookkeeping entries V1 never had (agent/model/location switches, idle markers,
 * compaction records, system notes, skill loads).
 */
export function toV1Message(raw: unknown, sessionID: string): V1MessageRow | undefined {
  const m = asLoose(raw)
  const id = String(m.id ?? "")
  const time = asLoose(m.time)
  const created = num(time.created) ?? 0
  const completed = num(time.completed)
  const part = (index: number, rest: Omit<V1Part, "id" | "sessionID" | "messageID">): V1Part => ({
    id: `${id}-p${index}`,
    sessionID,
    messageID: id,
    ...rest,
  })
  if (m.type === "user" || m.type === "synthetic") {
    const parts: V1Part[] = []
    const text = str(m.text)
    if (text) parts.push(part(0, { type: "text", text, ...(m.type === "synthetic" ? { synthetic: true } : {}) }))
    for (const f of Array.isArray(m.files) ? m.files.map(asLoose) : []) {
      const mime = str(f.mime) ?? "application/octet-stream"
      const data = str(f.data)
      const source = asLoose(f.source)
      const url = str(source.uri) ?? (data !== undefined ? `data:${mime};base64,${data}` : "")
      parts.push(part(parts.length, { type: "file", mime, url, ...(str(f.name) ? { filename: str(f.name) } : {}) }))
    }
    return { info: { id, sessionID, role: "user", time: { created } }, parts }
  }
  if (m.type === "assistant") {
    const model = asLoose(m.model)
    const agent = str(m.agent)
    const parts: V1Part[] = []
    for (const c of Array.isArray(m.content) ? m.content.map(asLoose) : []) {
      if ((c.type === "text" || c.type === "reasoning") && typeof c.text === "string") {
        parts.push(part(parts.length, { type: c.type, text: c.text }))
      } else if (c.type === "tool") {
        const state = asLoose(c.state)
        const status = TOOL_STATUS[String(state.status)] ?? String(state.status ?? "pending")
        const output = toolOutput(state.content)
        const error = str(asLoose(state.error).message)
        parts.push(
          part(parts.length, {
            type: "tool",
            callID: str(c.id) ?? "",
            tool: str(c.name) ?? "",
            state: { status, input: state.input ?? {}, ...(output !== undefined ? { output } : {}), ...(error ? { error } : {}) },
          }),
        )
      }
    }
    return {
      info: {
        id,
        sessionID,
        role: "assistant",
        time: { created, ...(completed !== undefined ? { completed } : {}) },
        ...(agent ? { agent, mode: agent } : {}),
        ...(str(model.id) ? { modelID: str(model.id), providerID: str(model.providerID) } : {}),
      },
      parts,
    }
  }
  if (m.type === "shell") {
    // V1 recorded a `!command` as a bash tool call; V2 keeps it as its own entry.
    const status = m.status === "running" ? "running" : "completed"
    const output = str(asLoose(m.output).output)
    return {
      info: { id, sessionID, role: "assistant", time: { created, ...(completed !== undefined ? { completed } : {}) } },
      parts: [
        part(0, {
          type: "tool",
          callID: id,
          tool: "bash",
          state: { status, input: { command: str(m.command) ?? "" }, ...(output !== undefined ? { output } : {}) },
        }),
      ],
    }
  }
  return undefined
}

/** A V2 event `{ id, created, type, data, location? }` as the V1 `{ type, properties }`. */
export function toV1Event(raw: unknown): RemoteControlEvent {
  const e = asLoose(raw)
  const type = String(e.type ?? "")
  const properties = asLoose(e.data ?? e.properties)
  // V1's session.deleted carried the session as `info`; V2 sends only its id.
  // Clients key the removal on `info.id`, so that much is rebuilt.
  if (type === "session.deleted" && typeof properties.sessionID === "string" && properties.info === undefined) {
    return { type, properties: { ...properties, info: { id: properties.sessionID } } }
  }
  return { type, properties }
}

/**
 * HTTP status for a failed host call. The in-process API rejects with tagged
 * errors (`…NotFound…`, schema/decode failures) or errors carrying a status;
 * anything else is a 500, like an upstream failure under V1.
 */
function errorStatus(error: unknown): number {
  let current: unknown = error
  for (let depth = 0; depth < 5 && typeof current === "object" && current !== null; depth++) {
    const e = current as Loose
    const status = num(e.status) ?? num(asLoose(e.response).status)
    if (status !== undefined && status >= 400 && status < 600) return status
    const tag = `${str(e._tag) ?? ""} ${str(e.name) ?? ""}`
    if (/NotFound/i.test(tag)) return 404
    if (/BadRequest|Schema|Parse|Decode|Invalid/i.test(tag)) return 400
    current = e.cause ?? e.error
  }
  return 500
}

function errorBody(error: unknown): { name: string; data: { message: string } } {
  const e = asLoose(error)
  const name = str(e._tag) ?? str(e.name) ?? "UnknownError"
  const message = str(e.message) ?? String(error)
  return { name, data: { message } }
}

/** A V1-ish error response: the upstream error with its own status, never a bare "not found". */
function failure(error: unknown): Response {
  return json(errorBody(error), errorStatus(error))
}

/** V1 prompt parts as the V2 prompt input: one text plus file attachments. */
function toPromptInput(parts: Array<TextPartInput | FilePartInput>): { text: string; files?: Array<{ uri: string; name?: string }> } {
  const text = parts
    .filter((p): p is TextPartInput => p.type === "text")
    .map((p) => p.text)
    .join("\n\n")
  const files = parts
    .filter((p): p is FilePartInput => p.type === "file")
    .map((p) => ({ uri: p.url, ...(p.filename ? { name: p.filename } : {}) }))
  return { text, ...(files.length > 0 ? { files } : {}) }
}

/**
 * V1 prompts and commands carried a per-request model and agent. V2 selects
 * them on the session instead, so a selector is applied as a switch before the
 * request — it then also stays the session's selection, as the last-used model
 * and agent did under V1.
 */
async function applySelection(api: RemoteControlApi, sessionID: string, model?: PromptModel, agent?: string): Promise<void> {
  if (agent) await api.session.switchAgent({ sessionID, agent })
  if (model) await api.session.switchModel({ sessionID, model: { id: model.modelID, providerID: model.providerID } })
}

/** Every session of this directory, newest first, following the V2 cursor. */
async function listV2Sessions(api: RemoteControlApi, directory: string): Promise<unknown[]> {
  const rows: unknown[] = []
  let cursor: string | undefined
  for (let page = 0; page < 20; page++) {
    const res = await api.session.list({ directory, ...(cursor ? { cursor } : {}) })
    rows.push(...(res.data ?? []))
    const next = res.cursor?.next
    if (typeof next !== "string" || next.length === 0 || next === cursor) break
    cursor = next
  }
  return rows
}

/**
 * The session's messages in V1 rows. V2 gives a plugin the session's model
 * context (`session.context`), not the full stored history, so a compacted
 * session shows what the model currently sees (from the compaction on).
 */
async function v1Messages(api: RemoteControlApi, sessionID: string): Promise<V1MessageRow[]> {
  const rows = await api.session.context({ sessionID })
  const out: V1MessageRow[] = []
  for (const row of rows ?? []) {
    const mapped = toV1Message(row, sessionID)
    if (mapped) out.push(mapped)
  }
  return out
}

/** The web page's session list: id, title and last update, newest first. */
async function webSessions(api: RemoteControlApi, directory: string): Promise<SessionRow[]> {
  const rows = (await listV2Sessions(api, directory)).map((s) => toV1Session(s, directory))
  return rows
    .map((s) => ({ id: s.id, title: s.title ?? "", updatedAt: s.time.updated }))
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
}

/** The web page's transcript: one { role, text } per message, tool calls as "[tool status]". */
async function webMessages(api: RemoteControlApi, sid: string): Promise<Array<{ role: string; text: string }>> {
  const rows: MessageRow[] = await v1Messages(api, sid)
  const out: Array<{ role: string; text: string }> = []
  for (const row of rows) {
    const chunks: string[] = []
    for (const part of row.parts ?? []) {
      if (part.type === "text" && part.text) chunks.push(part.text)
      else if (part.type === "tool" && part.tool) chunks.push(`[${part.tool}${part.state?.status ? " " + part.state.status : ""}]`)
    }
    const text = chunks.join("\n").trim()
    if (text) out.push({ role: row.info?.role ?? "assistant", text })
  }
  return out
}

/** V1 `config.providers`: connected providers, each with its `models` map, plus a per-provider `default`. */
async function v1Providers(api: RemoteControlApi, directory: string): Promise<{ providers: unknown[]; default: Record<string, string> }> {
  const location = { location: { directory } }
  const [providers, models, fallback] = await Promise.all([
    api.provider.list(location),
    api.model.list(location),
    api.model.default(location).catch(() => undefined),
  ])
  const byProvider = new Map<string, Loose[]>()
  for (const m of (models.data ?? []).map(asLoose)) {
    if (m.enabled === false) continue
    const providerID = String(m.providerID)
    byProvider.set(providerID, [...(byProvider.get(providerID) ?? []), m])
  }
  const defaultModel = asLoose(fallback?.data)
  const out: unknown[] = []
  const defaults: Record<string, string> = {}
  for (const p of (providers.data ?? []).map(asLoose)) {
    const id = String(p.id)
    const list = byProvider.get(id)
    if (!list || list.length === 0) continue
    const entries = list.map((m) => {
      const modelID = String(m.id)
      return [modelID, { ...m, id: modelID, providerID: id, name: str(m.name) ?? modelID }] as const
    })
    out.push({ ...p, id, name: str(p.name) ?? id, models: Object.fromEntries(entries) })
    defaults[id] = defaultModel.providerID === id && typeof defaultModel.id === "string" ? defaultModel.id : entries[0]![0]
  }
  return { providers: out, default: defaults }
}

/** V1 agents were addressed by `name`; in V2 that is the agent `id` (`name` is its display name). */
async function v1Agents(api: RemoteControlApi, directory: string): Promise<unknown[]> {
  const res = await api.agent.list({ location: { directory } })
  return (res.data ?? []).map((raw) => {
    const a = asLoose(raw)
    const model = asLoose(a.model)
    return {
      ...a,
      name: String(a.id ?? a.name),
      displayName: str(a.name),
      ...(str(model.id) ? { model: { providerID: str(model.providerID), modelID: str(model.id) } } : { model: undefined }),
    }
  })
}

/** V1 commands carried their `template`; V2 lists only name and description. */
async function v1Commands(api: RemoteControlApi, directory: string): Promise<unknown[]> {
  const res = await api.command.list({ location: { directory } })
  return (res.data ?? []).map((raw) => {
    const c = asLoose(raw)
    return { name: String(c.name), description: str(c.description) ?? "", template: "" }
  })
}

/**
 * Model and agent selectors arrive from an untrusted client, and both are
 * optional everywhere: leaving one out means "whatever this instance is
 * already using". A half-filled selector is dropped rather than forwarded,
 * because opencode rejects the whole prompt on a bad one and the phone would
 * see a 400 instead of a reply.
 */
function pickModel(value: unknown): PromptModel | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const { providerID, modelID } = value as Record<string, unknown>
  if (typeof providerID !== "string" || providerID.length === 0) return undefined
  if (typeof modelID !== "string" || modelID.length === 0) return undefined
  return { providerID, modelID }
}

function pickAgent(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const agent = value.trim()
  return agent.length > 0 ? agent : undefined
}

/**
 * Prompt parts arrive from an untrusted client, so each one is rebuilt field by
 * field rather than forwarded wholesale: only `text` and `file` survive, and
 * anything malformed or of another kind is dropped instead of failing the whole
 * prompt. A file part's `url` is whatever opencode itself accepts — a `data:`
 * URL is how a photo off a phone arrives, a `file://` path how a local
 * attachment does.
 */
function pickPromptParts(value: unknown): Array<TextPartInput | FilePartInput> {
  if (!Array.isArray(value)) return []
  const parts: Array<TextPartInput | FilePartInput> = []
  for (const raw of value) {
    if (typeof raw !== "object" || raw === null) continue
    const { type, text, mime, url, filename } = raw as Record<string, unknown>
    if (type === "text") {
      if (typeof text === "string" && text.length > 0) parts.push({ type: "text", text })
      continue
    }
    if (type === "file") {
      if (typeof mime !== "string" || mime.length === 0) continue
      if (typeof url !== "string" || url.length === 0) continue
      parts.push({
        type: "file",
        mime,
        url,
        ...(typeof filename === "string" && filename.length > 0 ? { filename } : {}),
      })
    }
  }
  return parts
}

// session.command names the model with a single "provider/model" string rather
// than the object prompt_async takes. Accept either form so a client can hold
// one model shape for both routes.
function pickCommandModel(value: unknown): string | undefined {
  if (typeof value === "string") {
    const model = value.trim()
    return model.length > 0 ? model : undefined
  }
  const model = pickModel(value)
  return model ? `${model.providerID}/${model.modelID}` : undefined
}

/**
 * Answers to a question request are one array of chosen option labels per
 * question, in the order the request listed them. Anything that is not a
 * string[][] is refused here rather than forwarded: opencode blocks the whole
 * turn on a pending question, and a malformed reply would leave it blocked
 * behind an upstream 500 the client cannot act on.
 */
function pickAnswers(value: unknown): string[][] | undefined {
  if (!Array.isArray(value)) return undefined
  const answers: string[][] = []
  for (const row of value) {
    if (!Array.isArray(row)) return undefined
    if (!row.every((label) => typeof label === "string")) return undefined
    answers.push(row as string[])
  }
  return answers
}

type LocalServer = { stop(closeActiveConnections?: boolean): void }
type ServeOptions = Parameters<typeof Bun.serve>[0]

/**
 * What Remote Control needs from the machine: a local HTTP server, the tailscale
 * CLI and the tailnet name. Exported (an object, so the loader never calls it) so
 * the contract tests can stand in for Bun and tailscale.
 */
export const remoteControlHost = {
  serve: (options: ServeOptions): LocalServer => Bun.serve(options),
  tailscale: (args: string[]): { ok: boolean; out: string } => runTailscale(args),
  machineHost: (): string | undefined => readMachineHost(),
  freePort: (): number => findFreePort(),
}

/**
 * One Remote Control registration in this process. Under opencode 2.3 a single
 * `opencode serve --service` process hosts every directory the TUI opens, and the
 * plugin's setup runs once per directory, so everything that used to be "this
 * process's" registration is kept per directory: its own server, port, mount,
 * token and registration entry (keyed by pid + directory in the state file).
 */
type Instance = { state: RemoteState; server: LocalServer }
const instances = new Map<string, Instance>()
let eventLog: Array<{ type: string; sessionID?: string }> = []
type WebClient = { session?: string; write: (chunk: string) => void }
// The web page's /api/events subscribers, per directory.
const sseClients = new Map<string, Set<WebClient>>()
type NativeStreamSink = { write: (chunk: string) => boolean }
// Phone / native clients on GET /event, keyed by instance directory and fed by
// the plugin's event subscription (forwardInstanceEvent).
const nativeStreamSinks = new Map<string, Set<NativeStreamSink>>()
// Live /event subscribers per directory, counted so a leaked subscription shows
// up in the log rather than only as quietly growing memory.
const openEventStreams = new Map<string, number>()

/** The key one directory's state is kept under: slash direction, case and a trailing slash don't matter. */
function dirKey(directory: string): string {
  return directory.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
}

function openStreamsOf(directory: string): number {
  return openEventStreams.get(dirKey(directory)) ?? 0
}

/** This directory's entry in the shared registration list: this process AND this directory. */
function isOwnRegistration(r: RemoteState, directory: string): boolean {
  return r.pid === process.pid && typeof r.directory === "string" && sameDirectory(r.directory, directory)
}

/**
 * Registrations are stored per machine as a LIST keyed by process pid AND
 * directory — multiple opencode instances (and, under opencode 2.3, several
 * directories hosted by one process) can be remote-controlled simultaneously,
 * and each may only modify its own entry. The mount used for a stop is
 * taken from memory (the starting process knows it); the file is advisory,
 * for `status` and cross-instance visibility.
 *
 * A phone bounce closes every instance's upstream stream within the same
 * millisecond, so several processes rewrite this file concurrently. An
 * unlocked read-modify-write loses entries to last-writer-wins and the
 * sidebar then shows phantom or missing connections. All mutations therefore
 * run inside a cross-process lock, drop registrations whose pid is gone, and
 * stay advisory: a failed or timed-out write must never take down an event
 * stream.
 */
function persistRegistrations(regs: RemoteState[]) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: Date.now(), registrations: regs }, null, 2))
}

const LOCK_FILE = join(STATE_DIR, "state.lock")
const LOCK_STEAL_MS = 500
const LOCK_TIMEOUT_MS = 3_000
const LOCK_RETRY_MS = 10

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

function lockHolder(): string {
  try {
    return readFileSync(LOCK_FILE, "utf8")
  } catch {
    return ""
  }
}

function stealStaleLock(): void {
  const [holderPid, stampedAt] = lockHolder().split(" ")
  const age = Date.now() - Number(stampedAt)
  if (!Number.isFinite(age) || age < LOCK_STEAL_MS) return
  try {
    unlinkSync(LOCK_FILE)
    log(`stale state lock stolen (held by pid ${holderPid ?? "?"})`)
  } catch {
    /* another process stole or released it first */
  }
}

function withStateLock<T>(work: () => T): T | undefined {
  mkdirSync(STATE_DIR, { recursive: true })
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    let fd: number
    try {
      fd = openSync(LOCK_FILE, "wx")
    } catch {
      if (Date.now() > deadline) {
        log(`state lock timed out after ${LOCK_TIMEOUT_MS}ms; registration write dropped`)
        return undefined
      }
      stealStaleLock()
      sleepSync(LOCK_RETRY_MS)
      continue
    }
    try {
      writeFileSync(fd, `${process.pid} ${Date.now()}`)
      return work()
    } finally {
      try {
        closeSync(fd)
        if (lockHolder().startsWith(`${process.pid} `)) unlinkSync(LOCK_FILE)
      } catch {
        /* the lock file is already handled elsewhere */
      }
    }
  }
}

function pruneDeadRegistrations(regs: RemoteState[]): RemoteState[] {
  return regs.filter((r) => r.pid === process.pid || pidAlive(r.pid))
}

function updateRegistrations(mutate: (regs: RemoteState[]) => RemoteState[], ...rest: unknown[]): void {
  if (isPluginLoaderMisfire(mutate, rest)) return {} as unknown as void
  withStateLock(() => {
    persistRegistrations(pruneDeadRegistrations(mutate(loadRegistrations())))
  })
}

export { updateRegistrations }

/**
 * Mirror the live subscriber count into this directory's entry so anything
 * reading the state file — the TUI sidebar, `status` — can tell "registered"
 * from "a phone is actually attached". Re-adds the entry if a clobber from an
 * older build removed it. Best effort by design: a failed write must never
 * take down an event stream.
 */
function persistClientCount(directory: string): void {
  try {
    const snapshot = instances.get(dirKey(directory))?.state
    if (!snapshot) return
    updateRegistrations((regs) => {
      const entry = { ...snapshot, clients: openStreamsOf(directory), updatedAt: Date.now() }
      const index = regs.findIndex((r) => isOwnRegistration(r, snapshot.directory))
      if (index === -1) return [...regs, entry]
      return regs.map((r, i) => (i === index ? { ...r, ...entry } : r))
    })
  } catch {
    /* advisory only */
  }
}

const HEARTBEAT_MS = 5_000
let heartbeat: ReturnType<typeof setInterval> | undefined

function startHeartbeat(): void {
  if (heartbeat) return
  heartbeat = setInterval(() => {
    for (const instance of instances.values()) persistClientCount(instance.state.directory)
  }, HEARTBEAT_MS)
  heartbeat.unref?.()
}

function stopHeartbeat(): void {
  if (!heartbeat) return
  clearInterval(heartbeat)
  heartbeat = undefined
}

function log(message: string): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    if (existsSync(LOG_FILE) && readFileSync(LOG_FILE).length > LOG_MAX_BYTES) writeFileSync(LOG_FILE, "")
    appendFileSync(LOG_FILE, `${new Date().toISOString()} pid=${process.pid} ${message}
`)
  } catch {
    /* diagnostics must never break the tool */
  }
}

function loadRegistrations(): RemoteState[] {
  try {
    if (!existsSync(STATE_FILE)) return []
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf8"))
    if (Array.isArray(raw?.registrations)) return raw.registrations as RemoteState[]
    // legacy single-registration shape
    if (raw?.url && raw?.token) return [raw as RemoteState]
    return []
  } catch {
    return []
  }
}

type MachineConfig = { pairingToken: string; createdAt: number }

let pairingCache: MachineConfig | undefined

/**
 * The pairing token identifies the MACHINE, not a session — it is what the
 * phone app stores after a single pairing and what gates the hub. Instance
 * tokens stay per-registration and short-lived; this one is durable.
 */
function pairingConfig(): MachineConfig {
  if (pairingCache) return pairingCache
  try {
    if (existsSync(MACHINE_FILE)) {
      const raw = JSON.parse(readFileSync(MACHINE_FILE, "utf8")) as Partial<MachineConfig>
      if (typeof raw?.pairingToken === "string" && raw.pairingToken.length > 0) {
        pairingCache = { pairingToken: raw.pairingToken, createdAt: raw.createdAt ?? Date.now() }
        return pairingCache
      }
    }
  } catch {
    /* unreadable/corrupt — mint a fresh one below */
  }
  return writePairingConfig(randomBytes(16).toString("hex"))
}

function writePairingConfig(token: string): MachineConfig {
  const config: MachineConfig = { pairingToken: token, createdAt: Date.now() }
  mkdirSync(MACHINE_DIR, { recursive: true })
  writeFileSync(MACHINE_FILE, JSON.stringify(config, null, 2))
  pairingCache = config
  return config
}

function rotatePairingToken(): MachineConfig {
  return writePairingConfig(randomBytes(16).toString("hex"))
}

function pairUrl(): string | undefined {
  const host = machineHost()
  if (!host) return undefined
  return `https://${host}${HUB_MOUNT}/?t=${pairingConfig().pairingToken}`
}

function portAlive(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const sock = connect({ host: "127.0.0.1", port })
    const done = (ok: boolean) => {
      sock.destroy()
      resolve(ok)
    }
    sock.setTimeout(1500)
    sock.once("connect", () => done(true))
    sock.once("timeout", () => done(false))
    sock.once("error", () => done(false))
  })
}

function pidAlive(pid: number): boolean {
  if (pid === process.pid) return true
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/**
 * Self-healing for crashed processes (dispose never ran): drop /rc-* tailscale
 * mounts whose backing port is dead, and registrations whose pid is gone.
 * Only touches our own mount namespace - never foreign handlers.
 */
async function pruneStale(): Promise<void> {
  // 1. Dead /rc-* mounts.
  const status = tailscale(["serve", "status", "--json"])
  if (status.ok) {
    try {
      const parsed = JSON.parse(status.out) as {
        Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
      }
      const mounts: string[] = []
      for (const host of Object.values(parsed.Web ?? {})) {
        for (const [mount, handler] of Object.entries(host.Handlers ?? {})) {
          if (!mount.startsWith("/rc-")) continue
          // The hub is ours and shared: keep it as long as anyone is registered,
          // even in the window where no process has rebound port 8579 yet.
          if (mount === HUB_MOUNT && liveRegistrations().length > 0) continue
          const port = Number(handler.Proxy?.match(/:(\d+)$/)?.[1])
          if (!port || !(await portAlive(port))) mounts.push(mount)
        }
      }
      for (const mount of mounts) void tailscale(["serve", "--set-path", mount, "off"])
    } catch {
      /* status format drift - skip pruning rather than guess */
    }
  }
  // 2. Dead-pid registrations.
  if (loadRegistrations().some((r) => !pidAlive(r.pid))) updateRegistrations((regs) => regs)
}

const TAILSCALE_CANDIDATES = process.platform === "win32"
  ? ["tailscale", "tailscale.exe", "C:\\Program Files\\Tailscale\\tailscale.exe"]
  : ["tailscale"]

const SPAWN_TIMEOUT_MS = 20_000
// Bun measures spawnSync's timeout against a clock that goes stale while the
// process idles: after an idle stretch longer than the timeout, the FIRST
// spawnSync comes back with ETIMEDOUT within milliseconds, the child never
// having run. That call refreshes the clock, so the next one works. A genuine
// timeout takes the full SPAWN_TIMEOUT_MS, so an ETIMEDOUT that returns almost
// instantly is the Bun artefact and is worth retrying.
// This is what left orphaned mounts behind: stop() is usually the first
// tailscale call after a long idle, and it only ever made one.
const SPURIOUS_TIMEOUT_MS = 1_000
const SPAWN_ATTEMPTS = 3

function spawnTailscale(cmd: string, args: string[]) {
  for (let attempt = 1; ; attempt++) {
    const startedAt = Date.now()
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: SPAWN_TIMEOUT_MS, windowsHide: true })
    const spurious =
      (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" &&
      Date.now() - startedAt < SPURIOUS_TIMEOUT_MS
    if (!spurious || attempt >= SPAWN_ATTEMPTS) return r
  }
}

function tailscale(args: string[]): { ok: boolean; out: string } {
  return remoteControlHost.tailscale(args)
}

function runTailscale(args: string[]): { ok: boolean; out: string } {
  let last = ""
  const startedAt = Date.now()
  for (const cmd of TAILSCALE_CANDIDATES) {
    const r = spawnTailscale(cmd, args)
    if (!r.error && r.status === 0) {
      const out = (r.stdout ?? "").trim()
      log(`tailscale ${args.join(" ")} -> ok in ${Date.now() - startedAt}ms (${out.length} bytes)`)
      return { ok: true, out }
    }
    last = [r.error?.message, r.stderr, r.stdout].filter(Boolean).join("\n").trim()
    log(`tailscale ${args.join(" ")} via ${cmd} -> error=${(r.error as NodeJS.ErrnoException | undefined)?.code ?? "-"} status=${r.status} ${last.slice(0, 160).replace(/\s+/g, " ")}`)
    // Spawn failed to find this candidate (ENOENT) -> try the next one.
    // Otherwise the CLI itself reported an error -> report it as-is.
    const enoent = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    if (!enoent) break
  }
  return { ok: false, out: last || "tailscale command not found on PATH" }
}

// The tailnet name never changes while the daemon runs, and the hub answers
// /instances on every app poll — cache it rather than spawning tailscale per
// request. Only successful lookups are cached.
let cachedHost: string | undefined

function machineHost(): string | undefined {
  return remoteControlHost.machineHost()
}

function readMachineHost(): string | undefined {
  if (cachedHost) return cachedHost
  for (const cmd of TAILSCALE_CANDIDATES) {
    const r = spawnTailscale(cmd, ["status", "--json"])
    if (r.error || r.status !== 0) continue
    try {
      const dns = (JSON.parse(r.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName
      if (dns) {
        cachedHost = dns.replace(/\.$/, "")
        return cachedHost
      }
    } catch {
      /* try next candidate */
    }
  }
  return undefined
}

function machineName(): string {
  return machineHost()?.split(".")[0] ?? hostname().split(".")[0] ?? "host"
}

/**
 * Instance identity the app can hold onto: the same working directory keeps
 * the same id across restarts, so a phone's per-instance state survives an
 * opencode relaunch. Two live processes on one directory are disambiguated by
 * pid rather than colliding.
 */
function instanceId(dir: string): string {
  const base = createHash("sha1").update(dir).digest("hex").slice(0, 12)
  const clash = loadRegistrations().some((r) => r.id === base && !isOwnRegistration(r, dir) && pidAlive(r.pid))
  return clash ? `${base}-${process.pid}` : base
}

function findFreePort(): number {
  for (let p = BASE_PORT; p < BASE_PORT + 20; p++) {
    try {
      const probe = Bun.serve({ hostname: "127.0.0.1", port: p, fetch: () => new Response("") })
      probe.stop(true)
      return p
    } catch {
      /* busy — try next */
    }
  }
  return BASE_PORT
}

/**
 * Bun.serve turns a throwing handler into a logged 500 under `opencode serve`,
 * but inside a TUI-hosted instance the escaping error has killed the process.
 * Every server handler goes through this so a bug in one route can only ever
 * cost that one response.
 */
function guarded(handler: (req: Request) => Response | Promise<Response>) {
  return async (req: Request): Promise<Response> => {
    try {
      return await handler(req)
    } catch (e) {
      log(`handler error ${req.method} ${new URL(req.url).pathname}: ${String(e).slice(0, 200)}`)
      return json({ error: "internal error" }, 500)
    }
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}

/**
 * Every endpoint accepts the caller's own token OR the durable machine pairing
 * token, through any of the three mechanisms — a paired app holds only the
 * pairing token and must still be able to talk to each instance.
 */
function authorized(req: Request, ...accepted: string[]): boolean {
  const tokens = new Set(accepted.filter(Boolean))
  const url = new URL(req.url)
  const query = url.searchParams.get("t")
  const header = req.headers.get("x-oc-token")
  if ((query && tokens.has(query)) || (header && tokens.has(header))) return true
  // Native clients (e.g. opencode-ios) auth with Basic: opencode:<token>.
  const auth = req.headers.get("authorization")
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6))
      const idx = decoded.indexOf(":")
      return idx >= 0 && tokens.has(decoded.slice(idx + 1))
    } catch {
      return false
    }
  }
  return false
}

function authorizedInstance(req: Request, tok: string): boolean {
  return authorized(req, tok, pairingConfig().pairingToken)
}

export type RemoteControlEvent = { type: string; properties?: unknown }

export type InstanceRouteDeps = {
  api: RemoteControlApi
  directory: string
  token: string
  getState: () => RemoteState | undefined
  /** The web page's /api/sessions; defaults to the session list read through `api`. */
  listSessions?: () => Promise<SessionRow[]>
  /** The web page's /api/messages; defaults to the transcript read through `api`. */
  messagesOf?: (sessionID: string) => Promise<Array<{ role: string; text: string }>>
  questionProxy: (path: string, body?: unknown) => Promise<Response>
  disconnect: () => void
  /** V1 `session.status`: busy/retry sessions by id, fed from the event stream. Idle ones are absent. */
  sessionStatus?: () => Record<string, unknown>
}

/** Thrown for a session id that exists but belongs to another directory: answered like an unknown id. */
class SessionNotInDirectory extends Error {
  readonly _tag = "Session.NotFoundError"
  readonly sessionID: string
  constructor(sessionID: string) {
    super(`Session not found: ${sessionID}`)
    this.sessionID = sessionID
    this.name = "Session.NotFoundError"
  }
}

export function makeInstanceRouteHandler(deps: InstanceRouteDeps, ...rest: unknown[]): (req: Request) => Promise<Response> {
  // deps legitimately carries api and directory (it needs them for the routes it
  // builds), so the shared shape check used elsewhere would false-positive here — this
  // export only ever takes one argument for real, so a second one is the loader misfire.
  if (rest.length > 0) return {} as unknown as (req: Request) => Promise<Response>
  const { api, directory, token: tok, getState, questionProxy, disconnect } = deps
  const listSessions = deps.listSessions ?? (() => webSessions(api, directory))
  const messagesOf = deps.messagesOf ?? ((sid: string) => webMessages(api, sid))
  const sessionStatus = deps.sessionStatus ?? (() => ({}))

  // V1 scoped every session call with `query: { directory }`; V2 addresses a
  // session by id alone, and one process hosts every directory. A session that
  // lives in another directory is answered exactly like an unknown id, so an
  // instance token never reaches another project's sessions.
  const owned = async (sessionID: string): Promise<void> => {
    const located = str(asLoose(asLoose(await api.session.get({ sessionID })).location).directory)
    if (located === undefined || !sameDirectory(located, directory)) throw new SessionNotInDirectory(sessionID)
  }

  // Runs one host call and answers with its (already V1-shaped) result, or with
  // the upstream error and its own status. `undefined` (a V2 call with no body)
  // answers 200 with an empty body, as the V1 SDK passthrough did.
  const sdk = async (run: () => Promise<unknown>): Promise<Response> => {
    try {
      const data = await run()
      return data === undefined ? new Response(null, { status: 200 }) : json(data)
    } catch (e) {
      return failure(e)
    }
  }

  return async (req: Request): Promise<Response> => {
    const url = new URL(req.url)
    const seg = url.pathname.replace(/\/+$/, "") || "/"
    if (seg === "/" || seg === "") {
      if (!authorizedInstance(req, tok)) return new Response("unauthorized", { status: 401 })
      return new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
    }
    if (!authorizedInstance(req, tok)) return json({ error: "unauthorized" }, 401)

    // Authenticated disconnect: same contract as /remote-control off. The
    // response goes out first and stop() runs a beat later, because stop()
    // closes the very server that is answering this request.
    if (seg === "/disconnect" && req.method === "POST") {
      setTimeout(disconnect, 100)
      return json({ ok: true, detail: "Remote Control off. Local session unaffected." })
    }

    // Native opencode REST surface so native clients (opencode-ios, any REST
    // app) can manage this TUI's sessions through the tunnel. Auth: Basic
    // opencode:<token> or ?t=/x-oc-token. Paths and shapes are opencode's V1
    // REST API; each one is served from the V2 plugin context and mapped back.
    const parts = seg.split("/").filter(Boolean)
    if (
      parts[0] === "session" ||
      parts[0] === "question" ||
      seg === "/event" ||
      seg === "/config/providers" ||
      seg === "/agent" ||
      seg === "/command"
    ) {
      try {
        if (seg === "/event" && req.method === "GET") return openInstanceEventStream(directory)
        // The model and agent catalogues, so a remote client can render a
        // picker instead of guessing at the instance defaults: providers each
        // carry their own `models` map alongside a `default` map, as V1 did.
        if (seg === "/config/providers" && req.method === "GET") {
          return sdk(() => v1Providers(api, directory))
        }
        if (seg === "/agent" && req.method === "GET") {
          return sdk(() => v1Agents(api, directory))
        }
        // The catalogue behind POST /session/:id/command. Without it a remote
        // client has to know a command's name up front, so it cannot offer a
        // command menu at all.
        if (seg === "/command" && req.method === "GET") {
          return sdk(() => v1Commands(api, directory))
        }
        // The question tool. The assistant blocks until a request is answered
        // or rejected, so a remote client needs all three routes or a question
        // asked over the tunnel strands the session with no way out.
        if (parts[0] === "question") {
          if (parts.length === 1 && req.method === "GET") return questionProxy("question")
          const requestID = parts[1]
          if (requestID && parts.length === 3 && req.method === "POST") {
            const target = "question/" + encodeURIComponent(requestID) + "/" + parts[2]
            if (parts[2] === "reject") return questionProxy(target, {})
            if (parts[2] === "reply") {
              const body = (await req.json().catch(() => ({}))) as { answers?: unknown }
              const answers = pickAnswers(body.answers)
              if (!answers) return json({ error: "answers must be an array of string arrays" }, 400)
              return questionProxy(target, { answers })
            }
          }
          return json({ error: "not found" }, 404)
        }
        if (parts[0] !== "session") return json({ error: "not found" }, 404)
        if (parts.length === 1) {
          if (req.method === "GET") {
            return sdk(async () => (await listV2Sessions(api, directory)).map((s) => toV1Session(s, directory)))
          }
          if (req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as { title?: string }
            return sdk(async () =>
              toV1Session(
                await api.session.create({
                  ...(typeof body.title === "string" ? { title: body.title } : {}),
                  location: { directory },
                }),
                directory,
              ),
            )
          }
        }
        if (parts.length === 2 && parts[1] === "status" && req.method === "GET") {
          return json(sessionStatus())
        }
        // Rename. The only field worth exposing to a remote client is the
        // title, and a blank one is rejected here rather than quietly clearing
        // it. V2's update answers nothing, so the renamed session is read back
        // to answer with it as V1 did.
        if (parts.length === 2 && req.method === "PATCH") {
          const id = parts[1]!
          const body = (await req.json().catch(() => ({}))) as { title?: unknown }
          const title = typeof body.title === "string" ? body.title.trim() : ""
          if (title.length === 0) return json({ error: "title required" }, 400)
          return sdk(async () => {
            await owned(id)
            await api.session.update({ sessionID: id, title })
            return toV1Session(await api.session.get({ sessionID: id }), directory)
          })
        }
        // Delete. Like the other per-id routes it re-emits an upstream error
        // (an unknown id included) with its own status and body instead of
        // succeeding silently. Deletion is permanent — the confirmation guard
        // lives in the client, not here.
        if (parts.length === 2 && req.method === "DELETE") {
          const id = parts[1]!
          return sdk(async () => {
            await owned(id)
            await api.session.remove({ sessionID: id })
            return true
          })
        }
        if (parts.length >= 3) {
          const id = parts[1]!
          if (parts[2] === "message" && req.method === "GET") {
            const limit = Number(url.searchParams.get("limit"))
            return sdk(async () => {
              await owned(id)
              const rows = await v1Messages(api, id)
              return Number.isFinite(limit) && limit > 0 ? rows.slice(-limit) : rows
            })
          }
          if (parts[2] === "prompt_async" && req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as {
              parts?: unknown
              model?: unknown
              agent?: unknown
            }
            const promptParts = pickPromptParts(body.parts)
            if (promptParts.length === 0) return json({ error: "parts required" }, 400)
            const model = pickModel(body.model)
            const agent = pickAgent(body.agent)
            return sdk(async () => {
              await owned(id)
              await applySelection(api, id, model, agent)
              await api.session.prompt({ sessionID: id, ...toPromptInput(promptParts) })
              return undefined
            })
          }
          if (parts[2] === "abort" && req.method === "POST") {
            // V2's interrupt answers `false` for an id it does not know; V1 failed
            // with the session's not-found error, so the id is checked first.
            return sdk(async () => {
              await owned(id)
              return (await api.session.interrupt({ sessionID: id })).interrupted
            })
          }
          if (parts[2] === "command" && req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as {
              command?: string
              arguments?: string
              messageID?: string
              model?: unknown
              agent?: unknown
            }
            const model = pickModel(splitCommandModel(pickCommandModel(body.model)))
            const agent = pickAgent(body.agent)
            return sdk(async () => {
              await owned(id)
              await applySelection(api, id, model, agent)
              await api.session.command({ sessionID: id, name: body.command ?? "", text: body.arguments ?? "" })
              return undefined
            })
          }
          if (parts[2] === "permissions" && parts[3] && req.method === "POST") {
            const body = (await req.json().catch(() => ({}))) as { response?: unknown }
            const decision = body.response
            if (decision !== "once" && decision !== "always" && decision !== "reject") {
              return json({ error: "response must be once, always or reject" }, 400)
            }
            const requestID = parts[3]
            return sdk(async () => {
              await owned(id)
              await api.permission.reply({ sessionID: id, requestID, decision })
              return true
            })
          }
        }
      } catch (e) {
        return json({ error: String(e) }, 502)
      }
    }

    if (url.pathname === "/api/status") return json({ ok: true, ...getState() })

    if (url.pathname === "/api/sessions") return json(await listSessions())

    if (url.pathname === "/api/messages") {
      const sid = url.searchParams.get("session")
      if (!sid) return json({ error: "session required" }, 400)
      try {
        await owned(sid)
      } catch (e) {
        return failure(e)
      }
      try {
        return json(await messagesOf(sid))
      } catch (e) {
        return json({ error: String(e) }, 502)
      }
    }

    if (url.pathname === "/api/send" && req.method === "POST") {
      const body = (await req.json()) as { session?: string; text?: string }
      if (!body.session || !body.text?.trim()) return json({ error: "session and text required" }, 400)
      try {
        await owned(body.session)
      } catch (e) {
        return failure(e)
      }
      await api.session.prompt({ sessionID: body.session, text: body.text.trim() })
      return json({ ok: true, queued: true })
    }

    if (url.pathname === "/api/new" && req.method === "POST") {
      const created = await api.session.create({ title: "remote", location: { directory } })
      return json({ id: created?.id })
    }

    if (url.pathname === "/api/events") {
      const sid = url.searchParams.get("session") ?? undefined
      let closed = false
      let keepalive: ReturnType<typeof setInterval> | undefined
      const enc = new TextEncoder()
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          const write = (chunk: string) => {
            if (closed) return
            controller.enqueue(enc.encode(chunk))
          }
          let clients = sseClients.get(dirKey(directory))
          if (!clients) {
            clients = new Set()
            sseClients.set(dirKey(directory), clients)
          }
          clients.add({ session: sid, write })
          write("retry: 3000\n\n")
          keepalive = setInterval(() => {
            if (closed) {
              if (keepalive) clearInterval(keepalive)
              return
            }
            write(": ping\n\n")
          }, SSE_KEEPALIVE_MS)
        },
        cancel() {
          closed = true
          if (keepalive) clearInterval(keepalive)
        },
      })
      return new Response(stream, {
        headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
      })
    }

    return json({ error: "not found" }, 404)
  }
}

// pickCommandModel yields V1's "provider/model" string; the V2 switch takes the
// pair back apart (the model id itself may contain "/", the provider never does).
function splitCommandModel(value: string | undefined): PromptModel | undefined {
  if (!value) return undefined
  const slash = value.indexOf("/")
  if (slash <= 0 || slash === value.length - 1) return undefined
  return { providerID: value.slice(0, slash), modelID: value.slice(slash + 1) }
}

/**
 * Live SDK event feed, in the shape native clients already speak: opencode's
 * own /global/event wraps every event as { directory, payload } and the app
 * reads `payload`. Emitting the bare SDK event here left `payload` undefined,
 * so the app threw on every frame and reconnected forever — nothing streamed.
 * Every event type is forwarded untouched; filtering belongs to the client.
 */
export function openInstanceEventStream(directory: string, ...rest: unknown[]): Response {
  if (isPluginLoaderMisfire(directory, rest)) return {} as unknown as Response
  const encoder = new TextEncoder()
  let closed = false
  let keepalive: ReturnType<typeof setInterval> | undefined
  let sink: NativeStreamSink | undefined

  const release = (reason: string) => {
    if (closed) return
    closed = true
    if (keepalive) clearInterval(keepalive)
    keepalive = undefined
    if (sink) nativeStreamSinks.get(directory)?.delete(sink)
    openEventStreams.set(dirKey(directory), Math.max(0, openStreamsOf(directory) - 1))
    persistClientCount(directory)
    log(`event stream closed (${reason}) dir=${directory} open=${openStreamsOf(directory)}`)
  }

  // Events come from the plugin's own V2 event subscription (ctx.event.subscribe,
  // mapped to the V1 { type, properties } shape and pushed via forwardInstanceEvent).
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      openEventStreams.set(dirKey(directory), openStreamsOf(directory) + 1)
      persistClientCount(directory)
      log(`event stream opened dir=${directory} open=${openStreamsOf(directory)}`)
      const write = (chunk: string): boolean => {
        if (closed) return false
        try {
          controller.enqueue(encoder.encode(chunk))
          return true
        } catch {
          release("write failed")
          try {
            controller.close()
          } catch {
            /* already closed */
          }
          return false
        }
      }
      sink = { write }
      let sinks = nativeStreamSinks.get(directory)
      if (!sinks) {
        sinks = new Set()
        nativeStreamSinks.set(directory, sinks)
      }
      sinks.add(sink)
      write("retry: 3000\n\n")
      write(`data: ${JSON.stringify({ directory, payload: { type: "server.connected", properties: {} } })}\n\n`)
      // tailscale serve (and any proxy in between) drops a stream that goes
      // quiet. A comment frame keeps it warm and every SSE parser ignores it.
      keepalive = setInterval(() => write(": ping\n\n"), SSE_KEEPALIVE_MS)
    },
    cancel() {
      release("client disconnected")
    },
  })

  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

export function forwardInstanceEvent(directory: string, event: RemoteControlEvent, ...rest: unknown[]): void {
  // The loader's malformed call also passes exactly two arguments (pluginInput,
  // options), so a third argument never distinguishes it here — only the shape of
  // `directory` does: a real caller always passes a string, the loader a PluginInput.
  if (isPluginLoaderMisfire(directory, rest)) return {} as unknown as void
  // Live /event subscribers get the event untouched inside the { directory,
  // payload } wrapper native clients already parse; filtering is the client's
  // job. Sinks are per directory, so one process never cross-posts another
  // instance's feed.
  const sinks = nativeStreamSinks.get(directory)
  if (sinks && sinks.size > 0) {
    const frame = `data: ${JSON.stringify({ directory, payload: event })}\n\n`
    for (const sink of sinks) {
      if (!sink.write(frame)) sinks.delete(sink)
    }
  }
  if (!event.type.startsWith("message") && !event.type.startsWith("session")) return
  const sid = (event.properties as { sessionID?: string } | undefined)?.sessionID
  eventLog.push({ type: event.type, sessionID: sid })
  if (eventLog.length > MAX_EVENTS) eventLog = eventLog.slice(-MAX_EVENTS)
  const line = `data: ${JSON.stringify({ type: event.type, sessionID: sid })}\n\n`
  const webClients = sseClients.get(dirKey(directory))
  for (const c of webClients ?? []) {
    if (!c.session || !sid || c.session === sid) {
      try {
        c.write(line)
      } catch {
        webClients?.delete(c)
      }
    }
  }
}

const EXECUTION_ENDED = new Set(["session.execution.succeeded", "session.execution.failed", "session.execution.interrupted"])

/**
 * One V2 event from the plugin's subscription, relayed to this directory's
 * clients in V1 shape. opencode 2 reports a session's run as
 * `session.execution.*` (and retries as `session.retry.scheduled`) where V1
 * sent `session.status` / `session.idle`, so those two are synthesised after
 * the original event, and `statuses` (V1's session.status map: busy and
 * retrying sessions only) is kept from the same events. Events located in
 * another directory are skipped; one without a location is kept.
 */
export function relayInstanceEvent(directory: string, raw: unknown, statuses: Map<string, unknown>): void {
  const located = asLoose(asLoose(raw).location).directory
  if (typeof located === "string" && !sameDirectory(located, directory)) return
  const event = toV1Event(raw)
  forwardInstanceEvent(directory, event)
  const props = asLoose(event.properties)
  const sessionID = str(props.sessionID)
  if (!sessionID) return
  const status = (value: unknown) => forwardInstanceEvent(directory, { type: "session.status", properties: { sessionID, status: value } })
  if (event.type === "session.status") {
    if (asLoose(props.status).type === "idle") statuses.delete(sessionID)
    else statuses.set(sessionID, props.status)
  } else if (event.type === "session.execution.started") {
    statuses.set(sessionID, { type: "busy" })
    status({ type: "busy" })
  } else if (event.type === "session.retry.scheduled") {
    const { sessionID: _id, ...retry } = props
    const value = { ...retry, type: "retry" }
    statuses.set(sessionID, value)
    status(value)
  } else if (EXECUTION_ENDED.has(event.type)) {
    statuses.delete(sessionID)
    status({ type: "idle" })
    forwardInstanceEvent(directory, { type: "session.idle", properties: { sessionID } })
  } else if (event.type === "session.deleted") {
    statuses.delete(sessionID)
  }
}

/** Same comparison for Windows paths that differ only in slash direction, case or a trailing slash. */
function sameDirectory(a: string, b: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
  return norm(a) === norm(b)
}

// ── Hub ─────────────────────────────────────────────────────────────────────
// One endpoint per MACHINE on a fixed port, so an app that paired once can see
// which instances are running here without knowing any instance token. The hub
// belongs to no particular instance: whichever registered process can bind the
// port hosts it, and the rest take over within a watchdog tick if it dies.

let hubServer: LocalServer | undefined
let hubWatchdog: ReturnType<typeof setInterval> | undefined

type InstanceView = {
  id: string
  name: string
  directory: string
  host: string
  mount: string
  port: number
  defaultSession: string
  startedAt: number
  alive: boolean
}

function liveRegistrations(): RemoteState[] {
  return loadRegistrations().filter((r) => pidAlive(r.pid))
}

/**
 * Registrations as the app sees them. Deliberately omits `token`: the hub is
 * reachable with the pairing token, and that must not be a way to harvest
 * every instance's credentials.
 */
function routedPorts(): Map<string, number> | undefined {
  const status = tailscale(["serve", "status", "--json"])
  if (!status.ok) return undefined
  try {
    const parsed = JSON.parse(status.out) as {
      Web?: Record<string, { Handlers?: Record<string, { Proxy?: string }> }>
    }
    const routes = new Map<string, number>()
    for (const host of Object.values(parsed.Web ?? {})) {
      for (const [mount, handler] of Object.entries(host.Handlers ?? {})) {
        const port = Number(handler.Proxy?.match(/:(\d+)$/)?.[1])
        if (port) routes.set(mount, port)
      }
    }
    return routes
  } catch {
    return undefined
  }
}

// A registration is only "alive" for the app if the phone can actually reach
// it: process up, port answering, AND tailscale still routes its mount there.
// (A mount that was replaced by another instance is reported as down rather
// than silently pointing the app at the wrong instance.)
function routed(routes: Map<string, number> | undefined, mount: string, port: number): boolean {
  return routes === undefined ? true : routes.get(mount) === port
}

async function instanceViews(): Promise<InstanceView[]> {
  const routes = routedPorts()
  return Promise.all(
    loadRegistrations().map(async (r) => ({
      id: r.id || createHash("sha1").update(r.directory || String(r.pid)).digest("hex").slice(0, 12),
      name: r.name,
      directory: r.directory ?? "",
      host: r.host || machineHost() || "",
      mount: r.mount || "/",
      port: r.port,
      defaultSession: r.defaultSession,
      startedAt: r.startedAt,
      alive: pidAlive(r.pid) && (await portAlive(r.port)) && routed(routes, r.mount || "/", r.port),
    })),
  )
}

function hubPage(instances: InstanceView[]): string {
  const rows = instances
    .map(
      (i) =>
        `<li><b>${escapeHtml(i.name)}</b> <span class="d">${escapeHtml(i.directory)}</span> <span class="${i.alive ? "up" : "down"}">${i.alive ? "running" : "stale"}</span></li>`,
    )
    .join("")
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>opencode remote — paired</title>
<style>body{background:#0d0f12;color:#d7dde6;font:15px/1.6 ui-sans-serif,system-ui,sans-serif;margin:0;padding:28px}
h1{font-size:19px;margin:0 0 4px}p{color:#7d8794;margin:0 0 18px}ul{list-style:none;padding:0;margin:0}
li{border:1px solid #242a33;border-radius:10px;padding:10px 13px;margin-bottom:8px}
.d{color:#7d8794;font-size:13px}.up{color:#5fd48a;font-size:13px}.down{color:#7d8794;font-size:13px}</style>
</head><body><h1>Paired &check;</h1><p>This machine is reachable. Instances running Remote Control:</p>
<ul>${rows || '<li class="d">none right now — run /remote-control in an opencode session</li>'}</ul></body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c] ?? c)
}

/**
 * `tailscale serve --set-path /rc-hub` strips the prefix before proxying, so
 * the paths seen here are bare: /, /health, /instances.
 */
async function hubHandler(req: Request): Promise<Response> {
  const seg = new URL(req.url).pathname.replace(/\/+$/, "") || "/"
  if (!authorized(req, pairingConfig().pairingToken)) {
    return seg === "/" ? new Response("unauthorized", { status: 401 }) : json({ error: "unauthorized" }, 401)
  }
  if (seg === "/health") return json({ ok: true })
  if (seg === "/instances") {
    return json({
      machine: { host: machineHost() ?? "", name: machineName() },
      instances: await instanceViews(),
    })
  }
  if (seg === "/") {
    return new Response(hubPage(await instanceViews()), {
      headers: { "content-type": "text/html; charset=utf-8" },
    })
  }
  return json({ error: "not found" }, 404)
}

function tryHostHub(): boolean {
  if (hubServer) return true
  try {
    hubServer = remoteControlHost.serve({ hostname: "127.0.0.1", port: HUB_PORT, idleTimeout: SERVER_IDLE_TIMEOUT_S, fetch: guarded(hubHandler) })
    return true
  } catch {
    return false // another instance already hosts it — the normal case
  }
}

/**
 * Called by every process that holds a registration. First one in wins the
 * port; the losers keep probing so the hub survives the host instance exiting
 * (or crashing) without any handoff protocol.
 */
function ensureHub(): void {
  tryHostHub()
  if (hubWatchdog) return
  hubWatchdog = setInterval(() => {
    if (hubServer) return
    void portAlive(HUB_PORT).then((up) => {
      if (!up) tryHostHub()
    })
  }, HUB_WATCHDOG_MS)
}

function releaseHub(): void {
  if (hubWatchdog) {
    clearInterval(hubWatchdog)
    hubWatchdog = undefined
  }
  if (hubServer) {
    hubServer.stop(true)
    hubServer = undefined
  }
}

function publishHub(): void {
  void tailscale(["serve", "--bg", "--set-path", HUB_MOUNT, String(HUB_PORT)])
}

const CLIENT_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<title>opencode remote</title>
<style>
  :root{--bg:#0d0f12;--panel:#161a20;--line:#242a33;--fg:#d7dde6;--dim:#7d8794;--acc:#6ea8fe;--user:#1d2a3d}
  *{box-sizing:border-box;margin:0}
  body{background:var(--bg);color:var(--fg);font:15px/1.5 ui-sans-serif,system-ui,sans-serif;height:100dvh;display:flex}
  aside{width:230px;background:var(--panel);border-right:1px solid var(--line);display:flex;flex-direction:column}
  aside h1{font-size:13px;padding:12px 14px;color:var(--dim);letter-spacing:.08em;text-transform:uppercase}
  #sessions{flex:1;overflow-y:auto}
  .sess{padding:9px 14px;border-bottom:1px solid var(--line);cursor:pointer;font-size:13.5px;color:var(--dim)}
  .sess:hover{background:var(--line)} .sess.on{color:var(--fg);background:var(--user);border-left:2px solid var(--acc)}
  #new{margin:10px;padding:8px;background:transparent;border:1px solid var(--line);color:var(--acc);border-radius:8px;font-size:13px}
  main{flex:1;display:flex;flex-direction:column;min-width:0}
  header{padding:10px 16px;border-bottom:1px solid var(--line);font-size:13px;color:var(--dim);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  #log{flex:1;overflow-y:auto;padding:16px}
  .msg{max-width:760px;margin:0 auto 14px}
  .msg .who{font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--dim);margin-bottom:3px}
  .msg .txt{white-space:pre-wrap;word-wrap:break-word}
  .msg.u .txt{background:var(--user);border-radius:10px;padding:9px 12px;display:inline-block}
  .msg.a .txt{color:var(--fg)} .msg.sys .txt{color:var(--dim);font-size:13px}
  form{display:flex;gap:8px;padding:10px;border-top:1px solid var(--line)}
  #in{flex:1;background:var(--panel);border:1px solid var(--line);color:var(--fg);border-radius:10px;padding:11px 13px;font:inherit;resize:none}
  button.go{background:var(--acc);border:0;color:#0b1220;border-radius:10px;padding:0 18px;font-weight:600}
  @media(max-width:640px){aside{display:none}}
</style></head><body>
<aside><h1>opencode</h1><div id="sessions"></div><button id="new">+ New session</button></aside>
<main>
  <header><span id="title">loading…</span></header>
  <div id="log"></div>
  <form id="f"><textarea id="in" rows="1" placeholder="Message…"></textarea><button class="go">Send</button></form>
</main>
<script>
// NOTE: relative API paths (no leading slash) so the client works both at the
// tailnet root and under a --set-path mount like /rc-xxxx.
const T = new URLSearchParams(location.search).get('t') || '';
const q = (p) => p + (p.includes('?') ? '&' : '?') + 't=' + T;
let cur = null;
const log = document.getElementById('log'), sess = document.getElementById('sessions'),
      title = document.getElementById('title'), inbox = document.getElementById('in');
const esc = (s) => { const d = document.createElement('div'); d.textContent = s || ''; return d.innerHTML; };
async function loadSessions(keep) {
  const list = await (await fetch(q('api/sessions'))).json();
  sess.innerHTML = '';
  for (const s of list) {
    const d = document.createElement('div');
    d.className = 'sess' + (s.id === cur ? ' on' : '');
    d.textContent = s.title || s.id.slice(0, 12);
    d.onclick = () => { cur = s.id; loadSessions(); loadMessages(); };
    sess.appendChild(d);
  }
  if (!cur || (!keep && !list.find(s => s.id === cur))) {
    const st = await (await fetch(q('api/status'))).json();
    cur = st.defaultSession || list[0]?.id;
    loadSessions(true); loadMessages();
  }
}
async function loadMessages() {
  if (!cur) return;
  const msgs = await (await fetch(q('api/messages?session=' + cur))).json();
  title.textContent = (msgs.find(m => m.role === 'user')?.text || '').slice(0, 90) || cur.slice(0, 14);
  const near = log.scrollHeight - log.scrollTop - log.clientHeight < 120;
  log.innerHTML = msgs.map(m =>
    '<div class="msg ' + (m.role === 'user' ? 'u' : 'a') + '"><div class="who">' + m.role + '</div><div class="txt">' + esc(m.text) + '</div></div>'
  ).join('');
  if (near) log.scrollTop = log.scrollHeight;
}
document.getElementById('f').onsubmit = async (e) => {
  e.preventDefault();
  const text = inbox.value.trim(); if (!text || !cur) return;
  inbox.value = '';
  await fetch(q('api/send'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ session: cur, text }) });
  setTimeout(loadMessages, 400);
};
document.getElementById('new').onclick = async () => {
  const s = await (await fetch(q('api/new'), { method: 'POST' })).json();
  cur = s.id; loadSessions(); loadMessages();
};
setInterval(() => loadSessions(true), 15000);
setInterval(loadMessages, 2500);
inbox.onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('f').requestSubmit(); } };
loadSessions();
</script></body></html>`

const REMOTE_CONTROL_SYSTEM_PROMPT = `Remote control (plugin primitive)
\`remote_control\` registers this session with the phone/browser client on the user's tailnet, so the conversation can be picked up from another device. Call it whenever the user asks about remote control or runs \`/remote-control\`, mapping their words to the action: empty or "toggle" toggles, "on" and "off" force a state, "status" reports, "pair" prints the once-per-machine pairing URL. Report every URL it returns verbatim - they carry tokens, so a paraphrase is useless. A connected phone streams this transcript live and drives the session through the same API, so nothing special is needed on your side while it is on: work exactly as you normally would.`

const REMOTE_CONTROL_TOOL_DESCRIPTION = `Register (or unregister) the current opencode session for Remote Control: continue this conversation from a phone, tablet, or any browser on your tailnet.

This tool backs the /remote-control command — always call it, never answer from memory. Map the command's argument words to \`action\`:
- empty, "toggle" → toggle (connects when off, disconnects when on)
- "on", "start" → on
- "off", "stop", "disconnect", "unregister" → off
- "status" → status
- "pair" → pair (prints the machine pair URL to paste into the phone app once)
- "rotate-pairing", "rotate" → rotate-pairing (mints a new pairing token; the old one stops working, so the app has to be re-paired)
Any other argument is a display name: pass it as \`name\` with action toggle (a name is only meaningful when connecting).

Report the tool output verbatim — especially the URL and any enable link. Never invent or modify the URL. If the output says Serve is not enabled, tell the user to click the enable link first.`

const REMOTE_CONTROL_ACTIONS = ["toggle", "on", "off", "status", "pair", "rotate-pairing"] as const
type RemoteControlAction = (typeof REMOTE_CONTROL_ACTIONS)[number]

// JSON Schema for the tool input: the same fields, enum and descriptions the V1
// zod schema declared.
const REMOTE_CONTROL_INPUT = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: [...REMOTE_CONTROL_ACTIONS],
      description:
        "toggle = flip on/off (default for a bare /remote-control), on = register, off = unregister, status = report, pair = print the machine pair URL for the app, rotate-pairing = mint a new pairing token and invalidate the old one",
    },
    name: {
      type: "string",
      description: "optional display name shown in the remote session list; only meaningful when connecting",
    },
  },
  required: ["action"],
}

function readToolInput(input: unknown): { action: RemoteControlAction; name?: string } {
  const raw = asLoose(input)
  const action = REMOTE_CONTROL_ACTIONS.find((a) => a === raw.action) ?? "toggle"
  const name = str(raw.name)
  return { action, ...(name ? { name } : {}) }
}

const RESUBSCRIBE_MIN_MS = 250
const RESUBSCRIBE_MAX_MS = 10_000

/**
 * Feeds every event of `subscribe()` to `onEvent` for as long as the plugin is
 * loaded. A stream that ends or throws is reopened after a short backoff
 * (doubling to a cap, reset once events flow again) instead of leaving the
 * plugin deaf for good; aborting `signal` (the plugin's unload) stops it. A
 * failing handler costs that one event, not the subscription.
 */
async function followEvents<E>(
  signal: AbortSignal,
  subscribe: () => AsyncIterable<E>,
  onEvent: (event: E) => void | Promise<void>,
  onError: (error: unknown) => void = () => {},
): Promise<void> {
  let delay = RESUBSCRIBE_MIN_MS
  while (!signal.aborted) {
    try {
      for await (const event of subscribe()) {
        delay = RESUBSCRIBE_MIN_MS
        try {
          await onEvent(event)
        } catch (error) {
          onError(error)
        }
      }
    } catch (error) {
      if (!signal.aborted) onError(error)
    }
    if (signal.aborted) return
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, delay)
      signal.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true })
    })
    delay = Math.min(delay * 2, RESUBSCRIBE_MAX_MS)
  }
}

async function setup(ctx: Plugin.Context): Promise<() => void> {
  const api: RemoteControlApi = ctx
  const directory: string = ctx.location.directory
  log(`plugin loaded dir=${directory} pid=${process.pid}`)

  /**
   * V1's question tool (and its /question routes) does not exist in opencode 2:
   * asking the user is a "form" there, and the plugin context exposes no form
   * API to answer one with. The routes stay so a client gets the same explicit
   * 502 a V1 instance gave when it could not reach them, rather than a 404.
   */
  async function questionProxy(path: string, _body?: unknown): Promise<Response> {
    log(`question route ${path} unavailable: opencode 2 has no question API for plugins`)
    return json({ error: "question routes unavailable on this instance" }, 502)
  }

  // V1's session.status: sessions that are busy or retrying, kept by
  // relayInstanceEvent from the event subscription. Idle sessions are absent.
  const statuses = new Map<string, unknown>()

  function makeHandler(tok: string, getState: () => RemoteState | undefined) {
    return makeInstanceRouteHandler({
      api,
      directory,
      token: tok,
      getState,
      questionProxy,
      disconnect: stop,
      sessionStatus: () => Object.fromEntries(statuses),
    })
  }

  const key = dirKey(directory)

  async function start(name: string | undefined, sessionID: string): Promise<string> {
    const active = instances.get(key)
    if (active) {
      return `Remote Control already active for this directory.\nURL: ${active.state.url}`
    }
    await pruneStale()
    // Another start for this directory (a resume racing a tool call) may have
    // finished while the stale mounts were pruned.
    const raced = instances.get(key)
    if (raced) return `Remote Control already active for this directory.\nURL: ${raced.state.url}`
    const tok = randomBytes(16).toString("hex")
    const port = remoteControlHost.freePort()
    const id = instanceId(directory)
    // One stable path per instance. The tailnet root is never claimed: a
    // path-less `serve --bg` silently replaces whatever holds "/", which is
    // exactly how one instance used to steal another's URL.
    const mount = `/rc-${id}`
    const state: RemoteState = {
      id,
      url: `https://PENDING/?t=${tok}`,
      token: tok,
      port,
      mount,
      name: name ?? `${basename(directory) || "opencode"} on ${machineName()}`,
      directory,
      host: "",
      defaultSession: sessionID,
      startedAt: Date.now(),
      pid: process.pid,
      clients: openStreamsOf(directory),
      updatedAt: Date.now(),
    }
    const handler = makeHandler(tok, () => state)

    const server = remoteControlHost.serve({ hostname: "127.0.0.1", port, idleTimeout: SERVER_IDLE_TIMEOUT_S, fetch: guarded(handler) })

    log(`start id=${id} port=${port} mount=${mount} dir=${directory}`)
    const serve = tailscale(["serve", "--bg", "--set-path", mount, String(port)])
    if (!serve.ok) {
      server.stop(true)
      log(`start failed: ${serve.out.slice(0, 200)}`)
      const enableUrl = serve.out.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=\S+/)?.[0]
      return enableUrl
        ? `Serve is not enabled on your tailnet yet. Enable it once (one click, admin of your tailnet) at:
${enableUrl}
Then run /remote-control again.`
        : `tailscale serve failed:
${serve.out}`
    }
    const host = machineHost()
    if (!host) {
      server.stop(true)
      void tailscale(["serve", "--set-path", mount, "off"])
      return "could not read tailnet hostname (tailscale status failed)"
    }
    state.host = host
    state.url = `https://${host}${mount}/?t=${tok}`
    instances.set(key, { state, server })
    updateRegistrations((regs) => [...regs.filter((r) => !isOwnRegistration(r, directory)), state])
    startHeartbeat()
    writeResume(directory, { name: state.name, defaultSession: sessionID ?? "" })
    // The hub is per machine, not per instance: publish the mount every time
    // (idempotent) and take the port if nobody holds it yet.
    publishHub()
    ensureHub()
    return [
      "Remote Control is ON for this session.",
      `Open from any device on your tailnet: ${state.url}`,
      "Token-gated and reachable only inside your tailnet — keep the URL private.",
      "/remote-control off disconnects. The local terminal keeps working normally.",
    ].join("\n")
  }

  /**
   * Turns Remote Control off for THIS directory only: its server, mount, web
   * clients and registration. The hub port and the heartbeat are shared by every
   * directory in the process, so they go only when no directory here is left.
   */
  function stop(explicit = true): string {
    const active = instances.get(key)
    instances.delete(key)
    active?.server.stop(true)
    // Drop the hub port too once nothing in this process is registered — any
    // other live instance rebinds it on its next watchdog tick, so the machine
    // stays discoverable.
    if (instances.size === 0) releaseHub()
    const webClients = sseClients.get(key)
    for (const c of webClients ?? []) {
      try {
        c.write("event: shutdown\ndata: {}\n\n")
      } catch {
        /* client gone */
      }
    }
    sseClients.delete(key)
    if (!active) return "Remote Control was not active for this directory."
    if (instances.size === 0) stopHeartbeat()
    // Our mount is known in memory — never trust the shared file for this.
    const mount = active.state.mount
    updateRegistrations((regs) => regs.filter((r) => !isOwnRegistration(r, directory)))
    if (explicit) clearResume(directory)
    log(`stop mount=${mount} dir=${directory}${explicit ? "" : " (resumable)"}`)
    // Targeted removal of OUR path only. The root is never ours to remove.
    const r = mount.startsWith("/rc-") ? tailscale(["serve", "--set-path", mount, "off"]) : { ok: true, out: "" }
    // The hub mount is shared: it goes away only with the last instance.
    if (liveRegistrations().length === 0) void tailscale(["serve", "--set-path", HUB_MOUNT, "off"])
    return r.ok ? "Remote Control off. Local session unaffected." : `Remote Control off, but tailscale removal failed: ${r.out}`
  }

  const resume = readResume(directory)
  if (
    resume !== undefined &&
    !instances.has(key) &&
    !loadRegistrations().some((r) => typeof r.directory === "string" && sameDirectory(r.directory, directory) && r.pid !== process.pid && pidAlive(r.pid))
  ) {
    log(`resuming remote control for ${directory}`)
    void start(resume.name, resume.defaultSession)
  }

  await ctx.session.hook("context", (input) => {
    try {
      if (input.system.some((part) => part.text === REMOTE_CONTROL_SYSTEM_PROMPT)) return
      input.system.push({ type: "text", text: REMOTE_CONTROL_SYSTEM_PROMPT })
    } catch {}
  })

  await ctx.tool.transform((tools) => {
    tools.add({
      name: "remote_control",
      description: REMOTE_CONTROL_TOOL_DESCRIPTION,
      input: REMOTE_CONTROL_INPUT,
      async execute(input, context) {
        return { content: await runTool(readToolInput(input), context.sessionID) }
      },
    })
  })

  async function runTool(args: { action: RemoteControlAction; name?: string }, sessionID: string): Promise<string> {
    if (args.action === "toggle") return instances.has(key) ? stop() : start(args.name || undefined, sessionID)
    if (args.action === "off") return stop()
    if (args.action === "pair" || args.action === "rotate-pairing") {
      if (args.action === "rotate-pairing") rotatePairingToken()
      const url = pairUrl()
      if (!url) return "could not read tailnet hostname (tailscale status failed) — is Tailscale running?"
      // Bring the hub up now so the app can verify the pairing straight
      // away, before any session has run /remote-control.
      publishHub()
      ensureHub()
      return [
        url,
        args.action === "rotate-pairing"
          ? "New pairing token. Paste this URL into the app once; the previous one no longer works."
          : "Paste this URL into the app once. Every instance that runs /remote-control on this machine then shows up automatically.",
      ].join("\n")
    }
    if (args.action === "status") {
      const regs = loadRegistrations()
      if (regs.length === 0) return "Remote Control: not active. Run /remote-control to register this session."
      const lines: string[] = []
      for (const r of regs) {
        const mine = isOwnRegistration(r, directory) ? " (this directory)" : ""
        lines.push(
          `${r.name}${mine} — active since ${new Date(r.startedAt).toLocaleTimeString()}\n  URL: ${r.url}\n  Default session: ${r.defaultSession}`,
        )
      }
      return `Remote Control: ${regs.length} active registration(s)\n${lines.join("\n")}`
    }
    return start(args.name || undefined, sessionID)
  }

  // V1's `event` hook is a subscription in V2; relayInstanceEvent maps each
  // event to the V1 shape the native clients parse.
  const subscription = new AbortController()
  void followEvents(
    subscription.signal,
    () => ctx.event.subscribe({ signal: subscription.signal }),
    (raw) => relayInstanceEvent(directory, raw, statuses),
    (e) => log(`event forward/subscription failed (resubscribing if it ended): ${String(e).slice(0, 160)}`),
  )

  return () => {
    subscription.abort()
    stop(false)
  }
}

export const RemoteControlPlugin = { id: "remote-control", setup } satisfies Plugin.Plugin

export default RemoteControlPlugin
