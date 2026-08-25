import type {
  RelayConsoleLine,
  RelayConsoleStreamEvent,
} from "@workspace/contracts"
import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { prepareFollowLogOutput, withFollowLogReader } from "./logs.js"

describe("followed CLI logs", () => {
  it("prints a limited chronological snapshot before unseen live lines", () => {
    const oldest = line("oldest", "Oldest", "2026-08-09T12:00:00.000Z")
    const recent = line("recent", "Recent", "2026-08-09T12:01:00.000Z")
    const newest = line("newest", "Newest", "2026-08-09T12:02:00.000Z")
    const live = line("live", "Live", "2026-08-09T12:03:00.000Z")
    const output = prepareFollowLogOutput([oldest, recent, newest], 2)
    const streamEvents: Array<RelayConsoleStreamEvent> = [
      {
        instanceId: "instance",
        lifecycle: [{ state: "started", time: "2026-08-09T12:00:00.000Z" }],
        lines: [recent, newest],
        truncated: true,
        type: "reset",
      },
      {
        instanceId: "instance",
        lifecycle: [{ state: "started", time: "2026-08-09T12:00:00.000Z" }],
        type: "ready",
      },
      {
        instanceId: "instance",
        lifecycle: [{ state: "started", time: "2026-08-09T12:00:00.000Z" }],
        lines: [oldest],
        truncated: false,
        type: "history",
      },
      { line: newest, type: "line" },
      { line: live, type: "line" },
    ]

    assert.deepEqual(
      output.initialLines.map((entry) => entry.text),
      ["Recent", "Newest"]
    )
    assert.deepEqual(
      streamEvents
        .map(output.liveLine)
        .filter((entry) => entry !== undefined)
        .map((entry) => entry.text),
      ["Live"]
    )
  })

  it.effect("cancels the stream when history bootstrap fails", () => {
    let canceled = false
    const body = new ReadableStream<Uint8Array>({
      cancel: () => {
        canceled = true
      },
    })

    return Effect.gen(function* () {
      yield* withFollowLogReader(body, () =>
        Effect.fail("history bootstrap failed")
      ).pipe(Effect.catch(() => Effect.void))

      assert.isTrue(canceled)
    })
  })
})

function line(id: string, text: string, timestamp: string): RelayConsoleLine {
  return { id, level: "info", text, timestamp }
}
