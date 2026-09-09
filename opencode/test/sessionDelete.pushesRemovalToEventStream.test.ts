import { test } from "node:test"
import assert from "node:assert/strict"
import { openTestInstance } from "./helpers/instance.ts"

function createSseFrameReader(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  async function nextRawFrame(timeoutMs = 5000): Promise<string | null> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const boundary = buffer.indexOf("\n\n")
      if (boundary !== -1) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        return frame
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for an SSE frame; received so far: ${JSON.stringify(buffer)}`)
      }
      const chunk = await reader.read()
      if (chunk.done) return buffer.length > 0 ? buffer : null
      buffer += decoder.decode(chunk.value, { stream: true })
    }
  }
  return {
    async next(): Promise<{ event?: string; data: unknown } | null> {
      for (;;) {
        const frame = await nextRawFrame()
        if (frame === null) return null
        let event: string | undefined
        let data: string | undefined
        for (const line of frame.split("\n")) {
          if (line.startsWith("event: ")) event = line.slice(7)
          else if (line.startsWith("data: ")) data = line.slice(6)
        }
        if (data === undefined) continue
        return { event, data: JSON.parse(data) }
      }
    },
    async cancel(): Promise<void> {
      await reader.cancel().catch(() => {})
    },
  }
}

test("a listener subscribed to the event stream is told about the deletion without polling", async () => {
  const instance = await openTestInstance({
    sessions: [{ id: "ses_mobile_lingering", title: "📱 New session" }],
  })

  const stream = await instance.request("GET", "/event")
  assert.equal(stream.status, 200)
  assert.match(stream.headers.get("content-type") ?? "", /text\/event-stream/)
  const frames = createSseFrameReader(stream.body as ReadableStream<Uint8Array>)
  try {
    const greeting = await frames.next()
    assert.deepEqual(greeting?.data, {
      directory: instance.directory,
      payload: { type: "server.connected", properties: {} },
    })

    const deleted = await instance.request("DELETE", "/session/ses_mobile_lingering")
    assert.equal(deleted.status, 200)

    const removal = await frames.next()
    assert.deepEqual(removal?.data, {
      directory: instance.directory,
      payload: {
        type: "session.deleted",
        properties: { info: { id: "ses_mobile_lingering", title: "📱 New session" } },
      },
    })

    assert.deepEqual(
      instance.fake.callNames(),
      ["session.delete"],
      "the listener must learn of the deletion from the pushed event, not by re-listing sessions",
    )
  } finally {
    await frames.cancel()
  }
})
