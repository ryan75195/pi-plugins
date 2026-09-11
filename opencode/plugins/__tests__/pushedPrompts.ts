/**
 * Harness support for the machine-pushed prompt marker contract.
 *
 * The goal, loop, monitor and background-task machinery all push prompts into
 * a session by calling `client.session.promptAsync` with a text part. These
 * helpers drive the real plugin factories against a fake opencode client and
 * record the raw `parts` of every push, so a test can assert that a pushed
 * prompt is marked while its text is still delivered.
 */
import { MonitorPlugin } from "../monitor.ts"
import { BackgroundTasksPlugin } from "../background-tasks.ts"

/** The metadata key a machine-pushed prompt part must carry. */
export const MACHINE_PUSHED_KEY = "machinePushed"

export type CapturedPart = {
  type: string
  text?: string
  synthetic?: boolean
  ignored?: boolean
  metadata?: Record<string, unknown>
}

export type CapturedPush = { sessionID: string; parts: CapturedPart[] }

/** True only for a part the plugin machinery pushed (as opposed to user input). */
export function isMachinePushed(part: CapturedPart): boolean {
  return part.metadata?.[MACHINE_PUSHED_KEY] === true
}

/** The text part of a push whose text satisfies `predicate`. */
export function textPartMatching(push: CapturedPush, predicate: (text: string) => boolean): CapturedPart | undefined {
  return push.parts.find((part) => part.type === "text" && typeof part.text === "string" && predicate(part.text))
}

function fakeClient(pushes: CapturedPush[]): any {
  return {
    session: {
      promptAsync: async (request: any) => {
        pushes.push({ sessionID: request?.path?.id, parts: (request?.body?.parts ?? []) as CapturedPart[] })
        return {}
      },
    },
    tui: { showToast: async () => ({}) },
    config: { get: async () => ({ data: {} }) },
  }
}

/** Wait for a push matching `predicate`, letting a spawned watch/task finish. */
export async function waitForPush(
  pushes: CapturedPush[],
  predicate: (push: CapturedPush) => boolean,
  timeoutMs = 8000,
): Promise<CapturedPush> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = pushes.find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  throw new Error(`timed out waiting for a pushed prompt; captured ${pushes.length}: ${JSON.stringify(pushes)}`)
}

/** Drive the real MonitorPlugin with a fake client, recording every push. */
export async function makeMonitorPushHarness(): Promise<{ plugin: any; pushes: CapturedPush[] }> {
  const pushes: CapturedPush[] = []
  const plugin: any = await MonitorPlugin({ client: fakeClient(pushes), directory: "/work/repo" } as any)
  return { plugin, pushes }
}

/** Drive the real BackgroundTasksPlugin with a fake client, recording every push. */
export async function makeBackgroundPushHarness(): Promise<{ plugin: any; pushes: CapturedPush[] }> {
  const pushes: CapturedPush[] = []
  const plugin: any = await BackgroundTasksPlugin({ client: fakeClient(pushes), directory: "/work/repo" } as any)
  return { plugin, pushes }
}
