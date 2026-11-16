/**
 * check-load — loads each TUI plugin directory the way opencode 2.3's TUI does
 * and renders its sections, without starting a TUI.
 *
 * The 2.3 loader resolves a local plugin directory with Host.resolve(...).tui
 * (the directory's `tui.tsx`), imports it, and refuses it unless the default
 * export has a non-empty string `id` and a `setup` function. This script does
 * the same, runs `setup` against a fake Context, renders every slot claim with
 * OpenTUI's test renderer against sample state files, and checks the text.
 *
 * The sample state goes in a fresh temp folder (the plugins read their state
 * files from the OS temp dir, so the script re-runs itself with TEMP/TMP
 * pointing there): it never touches a running opencode's state.
 *
 * Needs Bun with the OpenTUI Solid transform preloaded. The opencode binary is
 * a Bun build and runs as Bun with BUN_BE_BUN=1:
 *
 *   cd opencode/tui && npm install
 *   BUN_BE_BUN=1 opencode run --preload ./node_modules/@opentui/solid/scripts/preload.js check-load.ts
 *   # or, with Bun installed: npm run check:load
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PRELOAD = join(HERE, "node_modules", "@opentui", "solid", "scripts", "preload.js")

if (!process.env.TUI_CHECK_TEMP) {
	const temp = mkdtempSync(join(tmpdir(), "tui-check-"))
	const child = Bun.spawnSync([process.execPath, "run", "--preload", PRELOAD, fileURLToPath(import.meta.url)], {
		env: { ...process.env, TEMP: temp, TMP: temp, TMPDIR: temp, TUI_CHECK_TEMP: temp, OPENCODE_GOAL_STATE_DIR: join(temp, "goal-state") },
		stdout: "inherit",
		stderr: "inherit",
	})
	rmSync(temp, { recursive: true, force: true })
	process.exit(child.exitCode ?? 1)
}

const T = process.env.TUI_CHECK_TEMP
if (tmpdir() !== T) throw new Error(`tmpdir() is ${tmpdir()}, expected the private ${T}`)

const load = (name: string) => import(Bun.resolveSync(name, HERE))
const { Host } = await load("@opencode/plugin/host")
const { testRender } = await load("@opentui/solid")
const { RGBA } = await load("@opentui/core")

const c = (hex: string) => RGBA.fromHex(hex)
const theme = {
	text: {
		base: c("#eeeeee"),
		muted: c("#888888"),
		faint: c("#444444"),
		action: { primary: { base: c("#3399ff") }, secondary: { base: c("#999999") }, destructive: { base: c("#ff0000") } },
		feedback: {
			success: { base: c("#00ff00") },
			warning: { base: c("#ffff00") },
			error: { base: c("#ff0000") },
			info: { base: c("#00ffff") },
		},
	},
}

// A live process that is not this one, standing in for the opencode server.
const server = Bun.spawn(process.platform === "win32" ? ["ping", "-n", "60", "127.0.0.1"] : ["sleep", "60"], { stdout: "ignore" })
const now = Date.now()
const project = process.platform === "win32" ? "C:\\Some\\Project\\" : "/some/project/"
const write = (dir: string, data: unknown) => {
	mkdirSync(join(T, dir), { recursive: true })
	writeFileSync(join(T, dir, "state.json"), JSON.stringify(data))
}
write("opencode-background-tasks", {
	tasks: [
		{ id: "bg-1", sessionID: "ses_A", command: "npm run dev", description: "dev server", pid: process.pid, startedAt: now - 72_000, exitCode: null, status: "running", outputFile: "a", truncated: false },
		{ id: "bg-2", sessionID: "ses_A", command: "npm test", pid: 0, startedAt: now - 5000, finishedAt: now - 1000, exitCode: 1, status: "failed", outputFile: "b", truncated: false },
		{ id: "bg-3", sessionID: "ses_A", command: "sleep 100", pid: process.pid, startedAt: now - 3000, exitCode: null, status: "running", outputFile: "c", truncated: false, foreground: true, backgrounded: false },
	],
})
// goal-loop (opencode-architect) keeps one file per session: <repoKey>.<sessionID>.json,
// plus a .spent.json ledger the sidebar must ignore.
const goalDir = process.env.OPENCODE_GOAL_STATE_DIR!
mkdirSync(goalDir, { recursive: true })
writeFileSync(
	join(goalDir, "0123456789ab.ses_A.json"),
	JSON.stringify({ kind: "goal", text: "all tests pass", intervalMs: null, until: null, status: "active", turns: 3, maxTurns: 50, startedAt: now - 30_000, expiresAt: now + 3_600_000, lastReason: "2 tests still failing", stalledTurns: 0, agent: "build" }),
)
writeFileSync(join(goalDir, "0123456789ab.ses_A.spent.json"), JSON.stringify({ turns: 7 }))
// The older goal plugin's shared file: an older run for the same session, which must lose.
write("opencode-goal", {
	goals: [{ sessionID: "ses_A", condition: "stale legacy goal", startedAt: now - 900_000, turns: 9, status: "paused" }],
})
write("opencode-remote", {
	registrations: [{ id: "x", mount: "/rc-5e34d34d7587", name: "n", directory: project, startedAt: now - 60_000, pid: server.pid, clients: 1 }],
})

// What each plugin's sections must show for the sample state above.
const expected: Record<string, string[]> = {
	"background-tasks-sidebar": ["ctrl+b background · bg-3 sleep 100", "▸ Background tasks · 1 running"],
	"goal-indicator": ["◎ Goal active · 3", "3 turns", "all tests pass", "↳ 2 tests still failing"],
	"remote-control-sidebar": ["● Remote Control 1 client connected", "/rc-5e34d34d7587 · 1m"],
}

const toasts: Array<{ title?: string }> = []
let failures = 0
const check = (ok: boolean, what: string) => {
	console.log(`${ok ? "ok  " : "FAIL"} ${what}`)
	if (!ok) failures++
}

for (const name of Object.keys(expected)) {
	console.log(`\n== ${name}`)
	const entry: string | undefined = Host.resolve({ directory: join(HERE, name) }).tui
	check(entry !== undefined, `tui entrypoint resolves (${entry})`)
	if (!entry) continue
	const def = (await import(entry)).default
	check(typeof def === "object" && def !== null && typeof def.id === "string" && def.id.length > 0 && typeof def.setup === "function", `default export has id + setup (id ${def?.id})`)

	const claims: Array<Record<string, unknown> & { render: (input: unknown) => unknown; removed?: boolean }> = []
	const layers: Array<() => { priority?: number; commands: Array<{ id?: string; bind?: string | false; run: () => unknown }> }> = []
	const ctx = {
		options: {},
		location: { directory: "/elsewhere" },
		app: { version: "2.3.0", channel: "latest" },
		theme,
		themeMode: "dark",
		data: { session: { get: (id: string) => (id === "ses_A" ? { id, location: { directory: project.replace(/\\/g, "/").toLowerCase() } } : undefined) } },
		keymap: { layer: (factory: (typeof layers)[number]) => layers.push(factory) },
		ui: {
			slot: (claim: (typeof claims)[number]) => {
				claims.push(claim)
				return () => {
					claim.removed = true
				}
			},
			toast: { show: (o: { title?: string }) => toasts.push(o) },
			dialog: { confirm: async () => true },
			router: { current: () => ({ type: "session", sessionID: "ses_A" }) },
		},
	}
	const cleanup = await def.setup(ctx)
	await Bun.sleep(2300) // every plugin has polled its state file by now

	let text = ""
	for (const claim of claims) {
		const path = String(claim.append ?? claim.prepend ?? claim.replace ?? claim.before ?? claim.after)
		const r = await testRender(() => claim.render(path === "app" ? {} : { sessionID: "ses_A" }), { width: 70, height: 6 })
		await r.renderOnce()
		const frame = (r.captureCharFrame() as string).split("\n").map((l) => l.trimEnd()).filter(Boolean).join("\n")
		console.log(`  [${path}]\n${frame.replace(/^/gm, "    ") || "    (nothing)"}`)
		text += frame + "\n"
		r.renderer.destroy()
	}
	for (const want of expected[name]) check(text.includes(want), `shows "${want}"`)
	if (name === "goal-indicator") check(!text.includes("stale legacy goal"), "the newer goal-loop run wins over the older legacy entry")

	for (const factory of layers) {
		for (const cmd of factory().commands) {
			const result = cmd.run()
			check(result === undefined, `${cmd.id} (${cmd.bind}) backgrounds the blocking command`)
			await Bun.sleep(200) // the request file is written asynchronously
			const requests = JSON.parse(readFileSync(join(T, "opencode-background-tasks", "requests.json"), "utf8"))
			check(requests.backgroundSessions?.includes("ses_A"), "ctrl+b wrote the background request for the session")
		}
	}
	if (typeof cleanup === "function") await cleanup()
	check(claims.every((claim) => claim.removed), "cleanup removes every slot claim")
}
check(toasts.some((t) => t.title === "Moved to background"), "ctrl+b showed its toast")
server.kill()
console.log(failures ? `\n${failures} check(s) failed` : "\nall checks passed")
process.exit(failures ? 1 : 0)
