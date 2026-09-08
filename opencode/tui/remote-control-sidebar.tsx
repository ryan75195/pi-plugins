/**
 * remote-control-sidebar — opencode TUI plugin
 *
 * Renders a compact "Remote Control" section in the TUI sidebar (the panel on
 * the right, toggled with ctrl+x b). Pairs with the server-side plugin
 * opencode/plugins/remote-control.ts, which publishes one registration per
 * live instance — including a live client count — to a shared JSON file:
 *
 *   off:        ○ Remote Control  off · /remote-control to connect
 *   registered: ● Remote Control  on
 *               /rc-5e34d34d7587
 *   connected:  ● Remote Control  1 client connected
 *               /rc-5e34d34d7587 · 12m3s
 *
 * Install: add the path to this file to the `plugin` array in
 * ~/.config/opencode/tui.json (or .opencode/tui.json):
 *
 *   { "plugin": ["/absolute/path/to/remote-control-sidebar.tsx"] }
 */

import type { TuiPlugin } from "@opencode-ai/plugin/tui"
import { createMemo, createSignal, onCleanup, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

interface Registration {
	id: string
	mount: string
	name: string
	directory: string
	startedAt: number
	pid: number
	clients?: number
}

const STATE_FILE = join(process.env.TEMP ?? tmpdir(), "opencode-remote", "state.json")
const POLL_MS = 2000
const TICK_MS = 1000
const SIDEBAR_ORDER = 400 // above the goal (450) and background-tasks (500) sections
const MAX_MOUNT = 40

function humanDuration(ms: number): string {
	if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
	const m = Math.floor(ms / 60_000)
	const s = Math.round((ms % 60_000) / 1000)
	if (m < 60) return `${m}m${s}s`
	return `${Math.floor(m / 60)}h${m % 60}m`
}

function truncate(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text
}

function pidAlive(pid: number | undefined): boolean {
	if (!pid) return false
	try {
		process.kill(pid, 0)
		return true
	} catch {
		return false
	}
}

/** Windows paths differ in slash and case between the two processes. */
function samePath(a: string, b: string): boolean {
	const norm = (p: string) => p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase()
	return norm(a) === norm(b)
}

async function readRegistrations(): Promise<Registration[]> {
	try {
		const raw = JSON.parse(await readFile(STATE_FILE, "utf8")) as { registrations?: Registration[] }
		const regs = Array.isArray(raw.registrations) ? raw.registrations : []
		// A registration whose process is gone is a leftover, not a connection.
		return regs.filter((r) => pidAlive(r.pid))
	} catch {
		return []
	}
}

const tui: TuiPlugin = async (api) => {
	const [registrations, setRegistrations] = createSignal<Registration[]>([])
	const [now, setNow] = createSignal(Date.now())
	const cwd = process.cwd()

	const poll = async () => {
		setRegistrations(await readRegistrations())
	}
	const pollTimer = setInterval(poll, POLL_MS)
	const tickTimer = setInterval(() => setNow(Date.now()), TICK_MS)
	poll()

	const stopPolling = () => {
		clearInterval(pollTimer)
		clearInterval(tickTimer)
	}
	api.lifecycle.onDispose(stopPolling)
	onCleanup(stopPolling)

	// The server plugin lives in the opencode server process, which is a
	// different pid when the TUI spawns it — hence the directory fallback.
	const mine = createMemo(
		() => registrations().find((r) => r.pid === process.pid) ?? registrations().find((r) => samePath(r.directory, cwd)),
	)

	api.slots.register({
		order: SIDEBAR_ORDER,
		slots: {
			sidebar_content() {
				return (
					<Show
						when={mine()}
						fallback={
							<box flexDirection="row" gap={1}>
								<text fg={api.theme.current.textMuted}>○ Remote Control</text>
								<text fg={api.theme.current.textMuted}>off · /remote-control to connect</text>
							</box>
						}
					>
						{(reg) => {
							const clients = () => reg().clients ?? 0
							const status = () => (clients() > 0 ? `${clients()} client${clients() === 1 ? "" : "s"} connected` : "on")
							const dot = () => (clients() > 0 ? api.theme.current.success : api.theme.current.warning)
							const detail = () =>
								clients() > 0
									? `${truncate(reg().mount, MAX_MOUNT)} · ${humanDuration(now() - reg().startedAt)}`
									: truncate(reg().mount, MAX_MOUNT)
							return (
								<box>
									<box flexDirection="row" gap={1}>
										<text fg={dot()}>●</text>
										<text fg={api.theme.current.text}>
											<b>Remote Control</b>
										</text>
										<text fg={dot()}>{status()}</text>
									</box>
									<text fg={api.theme.current.textMuted}>{detail()}</text>
								</box>
							)
						}}
					</Show>
				)
			},
		},
	})
}

export default { id: "pi-plugins/remote-control-sidebar", tui }
