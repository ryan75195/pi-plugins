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
 */
import type { Plugin } from "@opencode-ai/plugin"
import type { FilePartInput, TextPartInput } from "@opencode-ai/sdk"
import { tool } from "@opencode-ai/plugin"
import { createHash, randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
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

let server: ReturnType<typeof Bun.serve> | undefined
let startedHere = false // this process actually published the tailscale serve entry
let activeState: RemoteState | undefined // this process's registration (in-memory truth)
let eventLog: Array<{ type: string; sessionID?: string }> = []
const sseClients = new Set<{ session?: string; write: (chunk: string) => void }>()
type NativeStreamSink = { write: (chunk: string) => boolean }
// Phone / native clients on GET /event, fed by the plugin event hook.
const nativeStreamSinks = new Set<NativeStreamSink>()
// Live /event subscribers, counted so a leaked subscription shows up in the log
// rather than only as quietly growing memory.
let openEventStreams = 0

/**
 * Registrations are stored per machine as a LIST keyed by process pid —
 * multiple opencode instances can be remote-controlled simultaneously, and
 * each instance may only modify its own entry. The mount used for a stop is
 * taken from memory (the starting process knows it); the file is advisory,
 * for `status` and cross-instance visibility.
 */
function persistRegistrations(regs: RemoteState[]) {
  mkdirSync(STATE_DIR, { recursive: true })
  writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: Date.now(), registrations: regs }, null, 2))
}

/**
 * Mirror the live subscriber count into this process's entry so anything
 * reading the state file — the TUI sidebar, `status` — can tell "registered"
 * from "a phone is actually attached". Best effort by design: a failed write
 * must never take down an event stream.
 */
function persistClientCount(): void {
  try {
    if (!activeState) return
    activeState.clients = openEventStreams
    activeState.updatedAt = Date.now()
    const regs = loadRegistrations()
    const index = regs.findIndex((r) => r.pid === process.pid)
    if (index === -1) return
    regs[index] = { ...regs[index], ...activeState }
    persistRegistrations(regs)
  } catch {
    /* advisory only */
  }
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
  const regs = loadRegistrations()
  const alive = regs.filter((r) => pidAlive(r.pid))
  if (alive.length !== regs.length) persistRegistrations(alive)
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
  const clash = loadRegistrations().some((r) => r.id === base && r.pid !== process.pid && pidAlive(r.pid))
  return clash ? `${base}-${process.pid}` : base
}

function freePort(): number {
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

export type RemoteControlSdkClient = Parameters<Plugin>[0]["client"]

export type RemoteControlEvent = { type: string; properties?: unknown }

export type InstanceRouteDeps = {
  client: RemoteControlSdkClient
  directory: string
  token: string
  getState: () => RemoteState | undefined
  listSessions: () => Promise<SessionRow[]>
  messagesOf: (sessionID: string) => Promise<Array<{ role: string; text: string }>>
  questionProxy: (path: string, body?: unknown) => Promise<Response>
}

export function makeInstanceRouteHandler(deps: InstanceRouteDeps): (req: Request) => Promise<Response> {
  throw new Error("NotImplementedException: makeInstanceRouteHandler")
}

export function openInstanceEventStream(directory: string): Response {
  throw new Error("NotImplementedException: openInstanceEventStream")
}

export function forwardInstanceEvent(directory: string, event: RemoteControlEvent): void {
  throw new Error("NotImplementedException: forwardInstanceEvent")
}

// ── Hub ─────────────────────────────────────────────────────────────────────
// One endpoint per MACHINE on a fixed port, so an app that paired once can see
// which instances are running here without knowing any instance token. The hub
// belongs to no particular instance: whichever registered process can bind the
// port hosts it, and the rest take over within a watchdog tick if it dies.

let hubServer: ReturnType<typeof Bun.serve> | undefined
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
    hubServer = Bun.serve({ hostname: "127.0.0.1", port: HUB_PORT, idleTimeout: SERVER_IDLE_TIMEOUT_S, fetch: guarded(hubHandler) })
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

export const RemoteControlPlugin: Plugin = async ({ client, directory, serverUrl }) => {
  log(`plugin loaded dir=${directory} serverUrl=${serverUrl?.href ?? "-"} pid=${process.pid}`)
  async function listSessions(): Promise<SessionRow[]> {
    const result = await client.session.list({ query: { directory } })
    const rows = (result.data ?? []) as Array<Record<string, unknown>>
    return rows
      .map((s) => ({ id: String(s.id), title: (s.title as string) ?? "", updatedAt: s.updatedAt as number | undefined }))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
  }

  async function messagesOf(sid: string): Promise<Array<{ role: string; text: string }>> {
    const result = await client.session.messages({ path: { id: sid }, query: { directory } })
    const rows = (result.data ?? []) as MessageRow[]
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

  /**
   * The question tool is newer than the SDK surface this plugin builds against:
   * `client` is the v1 OpencodeClient, and no published version of it carries a
   * `question` namespace — only `@opencode-ai/sdk/v2` does, behind a subpath a
   * plugin cannot count on resolving inside opencode's loader. `serverUrl` is
   * the very opencode server this plugin runs inside, so the question routes are
   * proxied with a plain fetch against the same paths the v2 client would call,
   * status and body passed straight through like the SDK-backed routes.
   */
  /**
   * The SDK the plugin builds against has no `question` namespace, and inside
   * a TUI-hosted (or `opencode run`) instance `serverUrl` points at a port
   * nothing listens on: the server lives in-process. The runtime client does
   * expose its underlying transport as `_client` (get/post over the same
   * in-process fetch every other SDK call uses), so the question routes ride
   * on that, with a plain fetch against `serverUrl` as the fallback for
   * `opencode serve`, where the port is real. Never throws: an escaping
   * handler error has killed a TUI process before.
   */
  type InnerResult = { data?: unknown; error?: unknown; response?: { status?: number } }
  type InnerClient = {
    get: (o: { url: string; query?: Record<string, unknown> }) => Promise<InnerResult>
    post: (o: { url: string; query?: Record<string, unknown>; body?: unknown }) => Promise<InnerResult>
  }
  const inner = (client as unknown as { _client?: InnerClient })._client

  async function questionViaInner(path: string, body: unknown | undefined): Promise<Response> {
    if (!inner) throw new Error("no inner client")
    const url = `/${path}`
    const res =
      body === undefined
        ? await inner.get({ url, query: { directory } })
        : await inner.post({ url, query: { directory }, body })
    const status = res.response?.status ?? (res.error !== undefined && res.error !== null ? 500 : 200)
    if (res.error !== undefined && res.error !== null) return json(res.error, status)
    return json(res.data ?? true, status)
  }

  async function questionViaFetch(path: string, body: unknown | undefined): Promise<Response> {
    const base = serverUrl.href.endsWith("/") ? serverUrl.href : serverUrl.href + "/"
    const target = new URL(path, base)
    target.searchParams.set("directory", directory)
    const upstream = await fetch(target, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined
        ? {}
        : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    })
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: { "content-type": upstream.headers.get("content-type") ?? "application/json" },
    })
  }

  async function questionProxy(path: string, body?: unknown): Promise<Response> {
    try {
      return await questionViaInner(path, body)
    } catch (innerError) {
      log(`question inner transport failed for ${path}: ${String(innerError).slice(0, 120)}`)
    }
    try {
      return await questionViaFetch(path, body)
    } catch (e) {
      log(`question proxy failed for ${path} via ${serverUrl?.href ?? "-"}: ${String(e).slice(0, 160)}`)
      return json({ error: "question routes unavailable on this instance" }, 502)
    }
  }

  function makeHandler(tok: string, getState: () => RemoteState | undefined) {
    return makeInstanceRouteHandler({
      client,
      directory,
      token: tok,
      getState,
      listSessions,
      messagesOf,
      questionProxy,
    })
  }

  async function start(name: string | undefined, sessionID: string): Promise<string> {
    if (server && activeState) {
      return `Remote Control already active in this process.\nURL: ${activeState.url}`
    }
    await pruneStale()
    const tok = randomBytes(16).toString("hex")
    const port = freePort()
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
      clients: openEventStreams,
      updatedAt: Date.now(),
    }
    const handler = makeHandler(tok, () => state)

    server = Bun.serve({ hostname: "127.0.0.1", port, idleTimeout: SERVER_IDLE_TIMEOUT_S, fetch: guarded(handler) })

    log(`start id=${id} port=${port} mount=${mount} dir=${directory}`)
    const serve = tailscale(["serve", "--bg", "--set-path", mount, String(port)])
    if (!serve.ok) {
      server.stop(true)
      server = undefined
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
      server = undefined
      void tailscale(["serve", "--set-path", mount, "off"])
      return "could not read tailnet hostname (tailscale status failed)"
    }
    state.host = host
    state.url = `https://${host}${mount}/?t=${tok}`
    activeState = state
    const regs = loadRegistrations().filter((r) => r.pid !== process.pid)
    regs.push(state)
    persistRegistrations(regs)
    startedHere = true
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

  function stop(): string {
    if (server) {
      server.stop(true)
      server = undefined
    }
    // Drop the hub port too — any other live instance rebinds it on its next
    // watchdog tick, so the machine stays discoverable.
    releaseHub()
    for (const c of sseClients) {
      try {
        c.write("event: shutdown\ndata: {}\n\n")
      } catch {
        /* client gone */
      }
    }
    sseClients.clear()
    if (!startedHere) return "Remote Control was not active in this process."
    startedHere = false
    // Our mount is known in memory — never trust the shared file for this.
    const mount = activeState?.mount
    activeState = undefined
    persistRegistrations(loadRegistrations().filter((r) => r.pid !== process.pid))
    log(`stop mount=${mount ?? "-"}`)
    // Targeted removal of OUR path only. The root is never ours to remove.
    const r =
      mount !== undefined && mount.startsWith("/rc-")
        ? tailscale(["serve", "--set-path", mount, "off"])
        : { ok: true, out: "" }
    // The hub mount is shared: it goes away only with the last instance.
    if (liveRegistrations().length === 0) void tailscale(["serve", "--set-path", HUB_MOUNT, "off"])
    return r.ok ? "Remote Control off. Local session unaffected." : `Remote Control off, but tailscale removal failed: ${r.out}`
  }

  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        if (output.system.includes(REMOTE_CONTROL_SYSTEM_PROMPT)) return
        output.system.push(REMOTE_CONTROL_SYSTEM_PROMPT)
      } catch {}
    },
    tool: {
      remote_control: tool({
        description: `Register (or unregister) the current opencode session for Remote Control: continue this conversation from a phone, tablet, or any browser on your tailnet.

This tool backs the /remote-control command — always call it, never answer from memory. Map the command's argument words to \`action\`:
- empty, "toggle" → toggle (connects when off, disconnects when on)
- "on", "start" → on
- "off", "stop", "disconnect", "unregister" → off
- "status" → status
- "pair" → pair (prints the machine pair URL to paste into the phone app once)
- "rotate-pairing", "rotate" → rotate-pairing (mints a new pairing token; the old one stops working, so the app has to be re-paired)
Any other argument is a display name: pass it as \`name\` with action toggle (a name is only meaningful when connecting).

Report the tool output verbatim — especially the URL and any enable link. Never invent or modify the URL. If the output says Serve is not enabled, tell the user to click the enable link first.`,
        args: {
          action: tool.schema
            .enum(["toggle", "on", "off", "status", "pair", "rotate-pairing"])
            .describe(
              "toggle = flip on/off (default for a bare /remote-control), on = register, off = unregister, status = report, pair = print the machine pair URL for the app, rotate-pairing = mint a new pairing token and invalidate the old one",
            ),
          name: tool.schema.string().optional().describe("optional display name shown in the remote session list; only meaningful when connecting"),
        },
        async execute(args, context) {
          if (args.action === "toggle") return server ? stop() : start(args.name || undefined, context.sessionID)
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
              const mine = r.pid === process.pid ? " (this process)" : ""
              lines.push(
                `${r.name}${mine} — active since ${new Date(r.startedAt).toLocaleTimeString()}\n  URL: ${r.url}\n  Default session: ${r.defaultSession}`,
              )
            }
            return `Remote Control: ${regs.length} active registration(s)\n${lines.join("\n")}`
          }
          return start(args.name || undefined, context.sessionID)
        },
      }),
    },
    event: async ({ event }) => {
      forwardInstanceEvent(directory, event)
    },
    async dispose() {
      stop()
    },
  }
}
