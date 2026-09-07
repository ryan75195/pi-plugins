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
 *
 * Substrate: `tailscale serve --bg` publishes the tailnet's HTTPS endpoint for
 * this machine and proxies it to a localhost-only HTTP endpoint hosted by this
 * plugin inside the opencode server process (Bun.serve). Nothing is exposed to
 * the public internet (that would be `funnel`), and the endpoint is token
 * gated on top of tailnet scoping.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { randomBytes } from "node:crypto"
import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
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
const BASE_PORT = 8580
const MAX_EVENTS = 400

type RemoteState = {
  url: string
  token: string
  port: number
  mount: string
  name: string
  defaultSession: string
  startedAt: number
  pid: number
}

type SessionRow = { id: string; title?: string; updatedAt?: number }
type MessageRow = {
  info: { role: string }
  parts: Array<{ type: string; text?: string; tool?: string; state?: { status?: string; output?: string } }>
}

let server: ReturnType<typeof Bun.serve> | undefined
let startedHere = false // this process actually published the tailscale serve entry
let activeState: RemoteState | undefined // this process's registration (in-memory truth)
let eventLog: Array<{ type: string; sessionID?: string }> = []
const sseClients = new Set<{ session?: string; write: (chunk: string) => void }>()

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

function tailscale(args: string[]): { ok: boolean; out: string } {
  let last = ""
  for (const cmd of TAILSCALE_CANDIDATES) {
    const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, windowsHide: true })
    if (!r.error && r.status === 0) return { ok: true, out: (r.stdout ?? "").trim() }
    last = [r.error?.message, r.stderr, r.stdout].filter(Boolean).join("\n").trim()
    // Spawn failed to find this candidate (ENOENT) -> try the next one.
    // Otherwise the CLI itself reported an error -> report it as-is.
    const enoent = (r.error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    if (!enoent) break
  }
  return { ok: false, out: last || "tailscale command not found on PATH" }
}

function machineHost(): string | undefined {
  for (const cmd of TAILSCALE_CANDIDATES) {
    const r = spawnSync(cmd, ["status", "--json"], { encoding: "utf8", timeout: 20_000, windowsHide: true })
    if (r.error || r.status !== 0) continue
    try {
      const dns = (JSON.parse(r.stdout) as { Self?: { DNSName?: string } }).Self?.DNSName
      if (dns) return dns.replace(/\.$/, "")
    } catch {
      /* try next candidate */
    }
  }
  return undefined
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

function authorized(req: Request, tok: string): boolean {
  const url = new URL(req.url)
  if (url.searchParams.get("t") === tok || req.headers.get("x-oc-token") === tok) return true
  // Native clients (e.g. opencode-ios) auth with Basic: opencode:<token>.
  const auth = req.headers.get("authorization")
  if (auth?.startsWith("Basic ")) {
    try {
      const decoded = atob(auth.slice(6))
      const idx = decoded.indexOf(":")
      return idx >= 0 && decoded.slice(idx + 1) === tok
    } catch {
      return false
    }
  }
  return false
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
        if (!authorized(req, tok)) return new Response("unauthorized", { status: 401 })
        return new Response(CLIENT_HTML, { headers: { "content-type": "text/html; charset=utf-8" } })
      }
      if (!authorized(req, tok)) return json({ error: "unauthorized" }, 401)

      // Native opencode REST surface so native clients (opencode-ios, any REST
      // app) can manage this TUI's sessions through the tunnel. Auth: Basic
      // opencode:<token> or ?t=/x-oc-token.
      const parts = seg.split("/").filter(Boolean)
      if (parts[0] === "session" || seg === "/event") {
        try {
          if (seg === "/event" && req.method === "GET") {
            const enc2 = new TextEncoder()
            const stream = new ReadableStream<Uint8Array>({
              async start(controller) {
                const write = (chunk: string) => {
                  try {
                    controller.enqueue(enc2.encode(chunk))
                  } catch {
                    /* client gone */
                  }
                }
                write("retry: 3000\n\n")
                try {
                  const sub = await client.event.subscribe()
                  for await (const event of sub.stream) {
                    write(`data: ${JSON.stringify(event)}\n\n`)
                  }
                } catch {
                  write("event: error\ndata: {}\n\n")
                }
                try {
                  controller.close()
                } catch {
                  /* already closed */
                }
              },
            })
            return new Response(stream, {
              headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
            })
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
              const body = (await req.json().catch(() => ({}))) as { parts?: Array<{ type: "text"; text: string }> }
              return sdk(() =>
                client.session.promptAsync({ path: { id }, body: { parts: body.parts ?? [] }, query: { directory } }),
              )
            }
            if (parts[2] === "command" && req.method === "POST") {
              const body = await req.json().catch(() => ({}))
              return sdk(() => client.session.command({ path: { id }, body: body as never, query: { directory } }))
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
    const mount = `/rc-${randomBytes(3).toString("hex")}`
    const state: RemoteState = {
      url: `https://PENDING/?t=${tok}`,
      token: tok,
      port,
      mount,
      name: name ?? `opencode on ${machineHost()?.split(".")[0] ?? "host"}`,
      defaultSession: sessionID,
      startedAt: Date.now(),
      pid: process.pid,
    }
    const handler = makeHandler(tok, () => state)

    server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handler })

    // First choice: own the tailnet root. If another instance (or anything
    // else) already publishes "/", mount under a unique path instead —
    // multiple instances can then be remote-controlled at once.
    let serve = tailscale(["serve", "--bg", String(port)])
    let path = ""
    if (!serve.ok) {
      serve = tailscale(["serve", "--bg", "--set-path", mount, String(port)])
      path = mount
    }
    if (!serve.ok) {
      server.stop(true)
      server = undefined
      const enableUrl = serve.out.match(/https:\/\/login\.tailscale\.com\/f\/serve\?node=\S+/)?.[0]
      return enableUrl
        ? `Serve is not enabled on your tailnet yet. Enable it once (one click, admin of your tailnet) at:\n${enableUrl}\nThen run /remote-control again.`
        : `tailscale serve failed:\n${serve.out}`
    }
    state.mount = path === "" ? "/" : mount
    const host = machineHost()
    if (!host) {
      server.stop(true)
      server = undefined
      void tailscale(["serve", "--set-path", mount, "off"])
      return "could not read tailnet hostname (tailscale status failed)"
    }
    state.url = `https://${host}${path}/?t=${tok}`
    activeState = state
    const regs = loadRegistrations().filter((r) => r.pid !== process.pid)
    regs.push(state)
    persistRegistrations(regs)
    startedHere = true
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
    const mount = activeState?.mount ?? "/"
    activeState = undefined
    persistRegistrations(loadRegistrations().filter((r) => r.pid !== process.pid))
    // Targeted removal of OUR mount only — never reset other instances' mounts.
    let r = tailscale(["serve", "--set-path", mount, "off"])
    if (!r.ok && mount === "/") r = tailscale(["serve", "reset"])
    return r.ok ? "Remote Control off. Local session unaffected." : `Remote Control off, but tailscale removal failed: ${r.out}`
  }

  return {
    tool: {
      remote_control: tool({
        description:
          "Register (or unregister) the current opencode session for Remote Control: continue this conversation from a phone, tablet, or any browser on your tailnet. Actions: 'toggle' turns it off if it is on, on if it is off — use this for a bare /remote-control. 'on' forces registration, 'off' unregisters, 'status' reports state.",
        args: {
          action: tool.schema.enum(["toggle", "on", "off", "status"]).describe("toggle = flip on/off (default for /remote-control), on = register, off = unregister, status = report"),
          name: tool.schema.string().optional().describe("optional display name shown in the remote session list"),
        },
        async execute(args, context) {
          if (args.action === "toggle") return server ? stop() : start(args.name || undefined, context.sessionID)
          if (args.action === "off") return stop()
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
