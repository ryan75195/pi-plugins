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

let server: ReturnType<typeof Bun.serve> | undefined
let startedHere = false // this process actually published the tailscale serve entry
let activeState: RemoteState | undefined // this process's registration (in-memory truth)
let eventLog: Array<{ type: string; sessionID?: string }> = []
const sseClients = new Set<{ session?: string; write: (chunk: string) => void }>()
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
    hubServer = Bun.serve({ hostname: "127.0.0.1", port: HUB_PORT, fetch: hubHandler })
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

export const RemoteControlPlugin: Plugin = async ({ client, directory }) => {
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
   * Live SDK event feed, in the shape native clients already speak: opencode's
   * own /global/event wraps every event as { directory, payload } and the app
   * reads `payload`. Emitting the bare SDK event here left `payload` undefined,
   * so the app threw on every frame and reconnected forever — nothing streamed.
   * Every event type is forwarded untouched; filtering belongs to the client.
   */
  function eventStream(): Response {
    const encoder = new TextEncoder()
    // The SDK's SSE client honours `signal`: aborting it cancels the reader and
    // ends the generator, so the upstream subscription is actually released
    // instead of iterating on for a client that has gone away.
    const upstream = new AbortController()
    let closed = false
    let keepalive: ReturnType<typeof setInterval> | undefined

    const release = (reason: string) => {
      if (closed) return
      closed = true
      if (keepalive) clearInterval(keepalive)
      keepalive = undefined
      upstream.abort()
      openEventStreams = Math.max(0, openEventStreams - 1)
      log(`event stream closed (${reason}) open=${openEventStreams}`)
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        openEventStreams++
        log(`event stream opened open=${openEventStreams}`)
        const write = (chunk: string): boolean => {
          if (closed) return false
          try {
            controller.enqueue(encoder.encode(chunk))
            return true
          } catch {
            release("write failed")
            return false
          }
        }
        write("retry: 3000\n\n")
        // tailscale serve (and any proxy in between) drops a stream that goes
        // quiet. A comment frame keeps it warm and every SSE parser ignores it.
        keepalive = setInterval(() => write(": ping\n\n"), 15_000)
        try {
          const sub = await client.event.subscribe({ signal: upstream.signal })
          for await (const event of sub.stream) {
            if (closed) break
            if (!write(`data: ${JSON.stringify({ directory, payload: event })}\n\n`)) break
          }
        } catch {
          write("event: error\ndata: {}\n\n")
        }
        release("upstream ended")
        try {
          controller.close()
        } catch {
          /* already closed */
        }
      },
      cancel() {
        release("client disconnected")
      },
    })

    return new Response(stream, {
      headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
    })
  }

  function makeHandler(tok: string, getState: () => RemoteState | undefined) {
    const sdk = async (
      run: () => Promise<{ data?: unknown; error?: unknown; response?: { status?: number } }>,
    ): Promise<Response> => {
      const res = await run()
      if (res.error !== undefined && res.error !== null) return json(res.error, res.response?.status ?? 500)
      return json(res.data)
    }

    return async (req: Request): Promise<Response> => {
      const url = new URL(req.url)
      const seg = url.pathname.replace(/\/+$/, "") || "/"
      if (seg === "/" || seg === "") {
        if (!authorizedInstance(req, tok)) return new Response("unauthorized", { status: 401 })
        return new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      if (!authorizedInstance(req, tok)) return json({ error: "unauthorized" }, 401)

      // Native opencode REST surface so native clients (opencode-ios, any REST
      // app) can manage this TUI's sessions through the tunnel. Auth: Basic
      // opencode:<token> or ?t=/x-oc-token.
      const parts = seg.split("/").filter(Boolean)
      if (parts[0] === "session" || seg === "/event" || seg === "/config/providers" || seg === "/agent") {
        try {
          if (seg === "/event" && req.method === "GET") return eventStream()
          // The model and agent catalogues, so a remote client can render a
          // picker instead of guessing at the instance defaults. Both are
          // returned exactly as the SDK gives them — each provider carries its
          // own `models` map alongside a `default` map — because reshaping
          // here would only date the client.
          if (seg === "/config/providers" && req.method === "GET") {
            return sdk(() => client.config.providers({ query: { directory } }))
          }
          if (seg === "/agent" && req.method === "GET") {
            return sdk(() => client.app.agents({ query: { directory } }))
          }
          if (parts[0] !== "session") return json({ error: "not found" }, 404)
          if (parts.length === 1) {
            if (req.method === "GET") return sdk(() => client.session.list({ query: { directory } }))
            if (req.method === "POST") {
              const body = (await req.json().catch(() => ({}))) as { title?: string }
              return sdk(() => client.session.create({ body: { title: body.title }, query: { directory } }))
            }
          }
          if (parts.length === 2 && parts[1] === "status" && req.method === "GET") {
            return sdk(() => client.session.status({ query: { directory } }))
          }
          if (parts.length >= 3) {
            const id = parts[1]
            if (parts[2] === "message" && req.method === "GET") {
              const limit = Number(url.searchParams.get("limit"))
              return sdk(() =>
                client.session.messages({
                  path: { id },
                  query: { ...(Number.isFinite(limit) && limit > 0 ? { limit } : {}), directory },
                }),
              )
            }
            if (parts[2] === "prompt_async" && req.method === "POST") {
              const body = (await req.json().catch(() => ({}))) as {
                parts?: Array<{ type: "text"; text: string }>
                model?: unknown
                agent?: unknown
              }
              const model = pickModel(body.model)
              const agent = pickAgent(body.agent)
              return sdk(() =>
                client.session.promptAsync({
                  path: { id },
                  body: { parts: body.parts ?? [], ...(model ? { model } : {}), ...(agent ? { agent } : {}) },
                  query: { directory },
                }),
              )
            }
            if (parts[2] === "abort" && req.method === "POST") {
              return sdk(() => client.session.abort({ path: { id }, query: { directory } }))
            }
            if (parts[2] === "command" && req.method === "POST") {
              const body = (await req.json().catch(() => ({}))) as {
                command?: string
                arguments?: string
                messageID?: string
                model?: unknown
                agent?: unknown
              }
              const model = pickCommandModel(body.model)
              const agent = pickAgent(body.agent)
              return sdk(() =>
                client.session.command({
                  path: { id },
                  body: {
                    command: body.command ?? "",
                    arguments: body.arguments ?? "",
                    ...(body.messageID ? { messageID: body.messageID } : {}),
                    ...(model ? { model } : {}),
                    ...(agent ? { agent } : {}),
                  },
                  query: { directory },
                }),
              )
            }
            if (parts[2] === "permissions" && parts[3] && req.method === "POST") {
              const body = (await req.json().catch(() => ({}))) as { response?: string }
              return sdk(() =>
                client.postSessionIdPermissionsPermissionId({
                  path: { id, permissionID: parts[3] },
                  body: { response: body.response as never },
                  query: { directory },
                }),
              )
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
          return json(await messagesOf(sid))
        } catch (e) {
          return json({ error: String(e) }, 502)
        }
      }

      if (url.pathname === "/api/send" && req.method === "POST") {
        const body = (await req.json()) as { session?: string; text?: string }
        if (!body.session || !body.text?.trim()) return json({ error: "session and text required" }, 400)
        await client.session.promptAsync({
          path: { id: body.session },
          body: { parts: [{ type: "text", text: body.text.trim() }] },
          query: { directory },
        })
        return json({ ok: true, queued: true })
      }

      if (url.pathname === "/api/new" && req.method === "POST") {
        const res = await client.session.create({ body: { title: "remote" }, query: { directory } })
        return json({ id: res.data?.id })
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
            sseClients.add({ session: sid, write })
            write("retry: 3000\n\n")
            keepalive = setInterval(() => {
              if (closed) {
                if (keepalive) clearInterval(keepalive)
                return
              }
              write(": ping\n\n")
            }, 15_000)
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
    }
    const handler = makeHandler(tok, () => state)

    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler })

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
    tool: {
      remote_control: tool({
        description:
          "Register (or unregister) the current opencode session for Remote Control: continue this conversation from a phone, tablet, or any browser on your tailnet. Actions: 'toggle' turns it off if it is on, on if it is off — use this for a bare /remote-control. 'on' forces registration, 'off' unregisters, 'status' reports state. 'pair' prints the one-time pair URL for the phone app (a machine-level token, valid for every instance on this machine); 'rotate-pairing' mints a new pairing token and invalidates the old one.",
        args: {
          action: tool.schema
            .enum(["toggle", "on", "off", "status", "pair", "rotate-pairing"])
            .describe(
              "toggle = flip on/off (default for /remote-control), on = register, off = unregister, status = report, pair = print the machine pair URL for the app, rotate-pairing = mint a new pairing token",
            ),
          name: tool.schema.string().optional().describe("optional display name shown in the remote session list"),
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
      if (!event.type.startsWith("message") && !event.type.startsWith("session")) return
      const sid = (event.properties as { sessionID?: string } | undefined)?.sessionID
      eventLog.push({ type: event.type, sessionID: sid })
      if (eventLog.length > MAX_EVENTS) eventLog = eventLog.slice(-MAX_EVENTS)
      const line = `data: ${JSON.stringify({ type: event.type, sessionID: sid })}\n\n`
      for (const c of sseClients) {
        if (!c.session || !sid || c.session === sid) {
          try {
            c.write(line)
          } catch {
            sseClients.delete(c)
          }
        }
      }
    },
    async dispose() {
      stop()
    },
  }
}
