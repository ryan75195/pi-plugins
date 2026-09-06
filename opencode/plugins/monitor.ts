/**
 * opencode Monitor — Claude Code Monitor tool parity.
 *
 * Watch something in the background and react when it changes, without
 * pausing the conversation:
 *   - `command`: run a script in the background; each stdout line is streamed
 *     back to the session as an event (coalesced into bursts).
 *   - `ws_url`: connect to a WebSocket feed; each text message is an event,
 *     binary frames become placeholders, >1MiB frames end the watch, close
 *     ends the watch with its code.
 *
 * Events are delivered as queued messages (promptAsync), so the agent
 * interjects between/after turns. Watches end at their deadline unless
 * `persistent`, and `monitor_stop` cancels them early.
 */
import type { Plugin } from "@opencode-ai/plugin"
import { tool } from "@opencode-ai/plugin"
import { spawn, type ChildProcess } from "node:child_process"
import { readFile, writeFile } from "node:fs/promises"
import { createInterface } from "node:readline"
import { lookup } from "node:dns/promises"
import { isIP } from "node:net"
import { randomBytes } from "node:crypto"
import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

// opencode runs on Bun, which provides a WebSocket client global.
declare const WebSocket: {
  new (url: string, protocols?: string[]): {
    close(): void
    addEventListener(type: string, listener: (ev: { data?: unknown; code?: number; reason?: string }) => void): void
  }
}

const STATE_DIR = join(process.env.TEMP ?? "/tmp", "opencode-monitor")
const STATE_FILE = join(STATE_DIR, "state.json")
// Shared task registry with the background-tasks plugin + its TUI sidebar:
// monitors appear as rows there and can be stopped from it.
const BG_DIR = join(process.env.TEMP ?? "/tmp", "opencode-background-tasks")
const BG_STATE_FILE = join(BG_DIR, "state.json")
const BG_REQUESTS_FILE = join(BG_DIR, "requests.json")

const DEFAULT_TIMEOUT_MS = 15 * 60_000
const FLUSH_INTERVAL_MS = 1200 // coalesce rapid lines into one event
const MAX_LINES_PER_EVENT = 80
const MAX_LINE_CHARS = 400
const MAX_EVENTS = 100 // event budget per watch, then auto-end (token guard)
const MAX_WS_FRAME = 1024 * 1024

type Watch = {
  id: string
  description: string
  sessionID: string
  directory: string
  source: "command" | "ws"
  target: string
  pattern?: RegExp
  startedAt: number
  endedAt?: number
  timeoutAt: number // Infinity when persistent
  events: number
  buffered: string[]
  flushTimer?: ReturnType<typeof setTimeout>
  proc?: ChildProcess
  sock?: { close(): void }
  ended: boolean
}

type SendText = (text: string) => Promise<void>

function persist(watches: Map<string, Watch>) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const rows = [...watches.values()].map((w) => ({
      id: w.id,
      description: w.description,
      source: w.source,
      target: w.target,
      sessionID: w.sessionID,
      startedAt: w.startedAt,
      events: w.events,
      ended: w.ended,
      persistent: w.timeoutAt === Infinity,
    }))
    writeFileSync(STATE_FILE, JSON.stringify({ updatedAt: Date.now(), watches: rows }, null, 2))
  } catch {
    /* best effort */
  }
}

function clip(line: string): string {
  return line.length > MAX_LINE_CHARS ? line.slice(0, MAX_LINE_CHARS) + "…" : line
}

/** Merge one watch into the shared task registry (never clobbers other rows). */
async function publishSnapshot(w: Watch) {
  const row = {
    id: w.id,
    sessionID: w.sessionID,
    command: w.target,
    description: `[monitor] ${w.description}`,
    pid: w.proc?.pid,
    startedAt: w.startedAt,
    finishedAt: w.ended ? Date.now() : undefined,
    exitCode: null,
    status: w.ended ? "stopped" : "running",
    outputFile: "",
    truncated: false,
    monitor: true,
  }
  try {
    let tasks: Array<Record<string, unknown>> = []
    try {
      const raw = JSON.parse(await readFile(BG_STATE_FILE, "utf8")) as { tasks?: Array<Record<string, unknown>> }
      tasks = (raw.tasks ?? []).filter((t) => t.id !== w.id)
    } catch {
      /* no registry yet */
    }
    if (!w.ended || w.events >= 0) tasks.push(row) // always publish; sidebar prunes ended rows itself    mkdirSync(BG_DIR, { recursive: true })
    writeFileSync(BG_STATE_FILE, JSON.stringify({ updatedAt: Date.now(), tasks }))
  } catch {
    /* best effort */
  }
}

/** Remove our ended rows from the shared registry after a linger period. */
async function pruneSnapshot(id: string) {
  try {
    const raw = JSON.parse(await readFile(BG_STATE_FILE, "utf8")) as { tasks?: Array<Record<string, unknown>> }
    const tasks = (raw.tasks ?? []).filter((t) => t.id !== id)
    writeFileSync(BG_STATE_FILE, JSON.stringify({ updatedAt: Date.now(), tasks }))
  } catch {
    /* nothing to prune */
  }
}

/** Claude Code parity: deny URLs pointing at private, link-local, or metadata addresses. */
async function isPrivateHost(hostname: string): Promise<boolean> {
  if (isIP(hostname)) return privateIP(hostname)
  try {
    const addrs = await lookup(hostname, { all: true, verbatim: true })
    return addrs.length === 0 || addrs.every((a) => privateIP(a.address))
  } catch {
    return true // unresolvable -> deny
  }
}

function privateIP(ip: string): boolean {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number)
    if (a === 0 || a === 10 || a === 127) return true
    if (a === 169 && b === 254) return true // link-local incl. cloud metadata
    if (a === 172 && b >= 16 && b <= 31) return true
    if (a === 192 && b === 168) return true
    if (a === 100 && b >= 64 && b <= 127) return true // CGNAT range (Tailscale etc.)
    return false
  }
  if (isIP(ip) === 6) {
    const lower = ip.toLowerCase()
    if (lower === "::" || lower === "::1") return true
    if (lower.startsWith("fe80")) return true // link-local
    if (lower.startsWith("fc") || lower.startsWith("fd")) return true // ULA
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)
    if (mapped) return privateIP(mapped[1])
    return false
  }
  return true
}

export const MonitorPlugin: Plugin = async ({ client, directory }) => {
  const watches = new Map<string, Watch>()

  const deliver = async (w: Watch, text: string) => {
    try {
      await client.session.promptAsync({
        path: { id: w.sessionID },
        body: { parts: [{ type: "text", text }] },
        query: { directory: w.directory },
      })
    } catch {
      /* session may be gone; the watch still ends cleanly */
    }
  }

  function end(w: Watch, reason: string) {
    if (w.ended) return
    w.ended = true
    w.endedAt = Date.now()
    if (w.flushTimer) clearTimeout(w.flushTimer)
    if (w.proc?.pid) {
      try {
        if (process.platform === "win32") spawn("taskkill", ["/T", "/F", "/PID", String(w.proc.pid)], { windowsHide: true })
        else w.proc.kill("SIGTERM")
      } catch {
        /* already gone */
      }
    }
    try {
      w.sock?.close()
    } catch {
      /* already closed */
    }
    watches.delete(w.id)
    persist(watches)
    void publishSnapshot(w)
    setTimeout(() => void pruneSnapshot(w.id), 60_000).unref?.()
    void deliver(
      w,
      w.buffered.length
        ? `[monitor ${w.id} ${w.description} ended: ${reason}]\n(final lines)\n${w.buffered.map(clip).join("\n")}`
        : `[monitor ${w.id} ${w.description} ended: ${reason}]`,
    )
  }

  function flush(w: Watch) {
    w.flushTimer = undefined
    if (w.ended || w.buffered.length === 0) return
    if (w.events >= MAX_EVENTS) {
      end(w, "event budget reached")
      return
    }
    const lines = w.buffered.splice(0, MAX_LINES_PER_EVENT)
    w.events += 1
    void deliver(w, `[monitor ${w.id} ${w.description}] event ${w.events}\n${lines.map(clip).join("\n")}`)
    if (w.buffered.length > 0 || lines.length === MAX_LINES_PER_EVENT) {
      w.flushTimer = setTimeout(() => flush(w), FLUSH_INTERVAL_MS)
    }
  }

  function line(w: Watch, text: string) {
    if (w.ended) return
    if (w.pattern && !w.pattern.test(text)) return
    w.buffered.push(text)
    if (!w.flushTimer) w.flushTimer = setTimeout(() => flush(w), FLUSH_INTERVAL_MS)
    if (w.buffered.length >= MAX_LINES_PER_EVENT) flush(w)
  }

  function startCommand(id: string, w: Watch, command: string): string | undefined {
    const proc = spawn(command, {
      shell: process.platform === "win32" ? true : "/bin/sh",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    })
    w.proc = proc
    let first = true
    for (const stream of [proc.stdout, proc.stderr]) {
      if (!stream) continue
      const rl = createInterface({ input: stream as NodeJS.ReadableStream })
      rl.on("line", (l) => {
        if (first && w.source === "command") first = false
        line(w, l)
      })
    }
    proc.on("error", (e) => end(w, `spawn error: ${e.message}`))
    proc.on("exit", (code) => {
      if (!w.ended) end(w, `command exited (code ${code ?? "signal"})`)
    })
    return undefined
  }

  async function startWebSocket(id: string, w: Watch, url: string, protocols: string[]): Promise<string | undefined> {
    let parsed: URL
    try {
      parsed = new URL(url)
    } catch {
      return `invalid WebSocket URL: ${url}`
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") return "ws_url must use ws:// or wss://"
    if (!/^[\x21-\x7E]+$/.test(url) || url.includes("@")) return "URL must be ASCII with no embedded credentials or whitespace"
    if (await isPrivateHost(parsed.hostname)) return `refused: ${parsed.hostname} resolves to a private/link-local/metadata address`
    if (new Set(protocols).size !== protocols.length) return "duplicate WebSocket subprotocols"

    const sock = new WebSocket(url, protocols.length ? protocols : undefined)
    w.sock = sock
    sock.addEventListener("message", (ev) => {
      if (w.ended) return
      const data = ev.data
      if (typeof data === "string") {
        for (const l of data.split("\n")) line(w, l)
        return
      }
      const size = data instanceof ArrayBuffer ? data.byteLength : data instanceof Uint8Array ? data.byteLength : 0
      if (size > MAX_WS_FRAME) {
        end(w, `frame too large (${size} bytes > 1MiB)`)
        return
      }
      line(w, `[binary frame, ${size} bytes]`)
    })
    sock.addEventListener("close", (ev) => {
      if (!w.ended) end(w, `socket closed (code ${ev.code ?? "unknown"})`)
    })
    sock.addEventListener("error", () => {
      if (!w.ended) end(w, "socket error")
    })
    return undefined
  }

  async function start(args: {
    description: string
    command?: string
    ws_url?: string
    ws_protocols?: string
    pattern?: string
    timeout_ms?: number
    persistent?: boolean
  }, sessionID: string): Promise<string> {
    if (!args.command && !args.ws_url) return "provide either `command` or `ws_url`"
    if (args.command && args.ws_url) return "provide only one of `command` or `ws_url`"
    let pattern: RegExp | undefined
    if (args.pattern) {
      try {
        pattern = new RegExp(args.pattern)
      } catch (e) {
        return `invalid pattern: ${e}`
      }
    }
    const id = "m" + randomBytes(3).toString("hex")
    const timeout = args.persistent ? Infinity : Math.max(1000, args.timeout_ms ?? DEFAULT_TIMEOUT_MS)
    const w: Watch = {
      id,
      description: args.description || args.command || args.ws_url || "watch",
      sessionID,
      directory,
      source: args.ws_url ? "ws" : "command",
      target: args.command ?? args.ws_url ?? "",
      pattern,
      startedAt: Date.now(),
      timeoutAt: timeout === Infinity ? Infinity : Date.now() + timeout,
      events: 0,
      buffered: [],
      ended: false,
    }

    let err: string | undefined
    if (args.ws_url) {
      const protocols = (args.ws_protocols ?? "").split(",").map((s) => s.trim()).filter(Boolean)
      err = await startWebSocket(id, w, args.ws_url, protocols)
    } else {
      err = startCommand(id, w, args.command as string)
    }
    if (err) {
      w.ended = true
      return err
    }

    watches.set(id, w)
    persist(watches)
    void publishSnapshot(w)

    if (timeout !== Infinity) {
      setTimeout(() => end(w, "timeout reached"), timeout).unref?.()
    }
    return [
      `Watching (${id}): ${w.description}`,
      args.ws_url ? `WebSocket feed: ${args.ws_url}` : `Command: ${args.command}`,
      timeout === Infinity ? "Runs until monitor_stop or session end." : `Ends automatically at ${new Date(w.timeoutAt).toLocaleTimeString()} unless persistent.`,
      `Each ${args.ws_url ? "message" : "output line"} arrives as an [monitor …] event message${pattern ? ` (filtered by /${args.pattern}/)` : ""} — react when they arrive, keep working otherwise.`,
      `Stop with monitor_stop (id: ${id}).`,
    ].join("\n")
  }

  function stopOne(id: string): string {
    const w = watches.get(id)
    if (!w) return `no active watch '${id}' (active: ${[...watches.keys()].join(", ") || "none"})`
    end(w, "stopped by monitor_stop")
    return `stopped ${id}`
  }

  // Consume stop requests from the shared requests file that target OUR watch
  // ids, leaving entries owned by other plugins (e.g. background tasks).
  let requestPoller: ReturnType<typeof setInterval> | undefined
  function ensureRequestPoller() {
    if (requestPoller) return
    requestPoller = setInterval(() => {
      void (async () => {
        let stop: string[] = []
        try {
          const raw = JSON.parse(await readFile(BG_REQUESTS_FILE, "utf8")) as { stop?: string[] }
          stop = raw.stop ?? []
        } catch {
          return
        }
        const mine = stop.filter((id) => watches.has(id))
        if (mine.length === 0) return
        try {
          const raw = JSON.parse(await readFile(BG_REQUESTS_FILE, "utf8")) as { stop?: string[]; backgroundSessions?: string[] }
          await writeFile(
            BG_REQUESTS_FILE,
            JSON.stringify({ stop: (raw.stop ?? []).filter((id) => !watches.has(id)), backgroundSessions: raw.backgroundSessions ?? [] }),
          )
        } catch {
          /* racing writer — worst case the stop is processed twice, which is harmless */
        }
        for (const id of mine) stopOne(id)
      })()
    }, 1000)
    requestPoller.unref?.()
  }
  ensureRequestPoller()

  return {
    tool: {
      monitor: tool({
        description:
          "Start a background watch and stream its output into this session as events, so you can react mid-conversation. Use it to tail logs and flag errors, poll CI/PR status until it changes, watch a directory via a script, or connect to a WebSocket feed. Provide either `command` (its stdout lines become events — make the script print only what matters) or `ws_url`. The watch ends at the deadline unless persistent; deliver at most a bounded number of events, then it ends to protect context.",
        args: {
          command: tool.schema.string().optional().describe("shell command to run in the background; each stdout line becomes an event. Mutually exclusive with ws_url."),
          ws_url: tool.schema.string().optional().describe("ws:// or wss:// URL; each text message becomes an event. Mutually exclusive with command."),
          ws_protocols: tool.schema.string().optional().describe("comma-separated WebSocket subprotocols to offer"),
          description: tool.schema.string().describe("short label shown in every event, e.g. 'dev server log' or 'CI status'"),
          pattern: tool.schema.string().optional().describe("optional regex; only lines matching it are forwarded (saves tokens on noisy output)"),
          timeout_ms: tool.schema.number().optional().describe("watch deadline; default 15 minutes"),
          persistent: tool.schema.boolean().optional().describe("run until monitor_stop / session end, ignoring the deadline"),
        },
        async execute(args, context) {
          return start(args, context.sessionID)
        },
      }),

      monitor_stop: tool({
        description: "Cancel one background watch started with the monitor tool, or all of them. Watches also end on their deadline, when their command exits, or when the session ends.",
        args: {
          id: tool.schema.string().optional().describe("watch id from the monitor result; omit or use 'all' to stop every active watch"),
        },
        async execute(args) {
          if (!args.id || args.id === "all") {
            const ids = [...watches.keys()]
            ids.forEach(stopOne)
            return ids.length ? `stopped ${ids.length} watch(es): ${ids.join(", ")}` : "no active watches"
          }
          return stopOne(args.id)
        },
      }),
    },
    event: async ({ event }) => {
      // A session ending takes its watches with it (Claude Code parity).
      if (event.type === "session.deleted") {
        const sid = (event.properties as { sessionID?: string } | undefined)?.sessionID
        for (const w of [...watches.values()]) {
          if (w.sessionID === sid) end(w, "session ended")
        }
      }
    },
    async dispose() {
      if (requestPoller) clearInterval(requestPoller)
      for (const w of [...watches.values()]) end(w, "session ended")
    },
  }
}
