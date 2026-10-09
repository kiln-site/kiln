import {
  relayControlMaxFrameBytes,
  type HearthDatabaseLogsOutput,
  type RelayConsoleLine,
  type RelayManagedDatabase,
} from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import { DatabaseLogs, FOLLOWER_EXPIRES_AFTER_MS } from "./database-logs.js"

const alice = "hearth:alice"
const mallory = "hearth:mallory"
const database = { containerId: "database-container" } as RelayManagedDatabase

afterEach(() => {
  vi.useRealTimers()
})

// The database container's output as `docker logs --follow` gives it: lines
// written so far, then more as they're written, until the container stops.
function container() {
  const queue: Array<RelayConsoleLine> = []
  const signals: Array<AbortSignal> = []
  let stopped = false
  let wake: (() => void) | null = null
  let next = 0
  return {
    docker: {
      streamContainerLogs: (_containerId: string, signal: AbortSignal) => {
        signals.push(signal)
        return (async function* () {
          for (;;) {
            if (signal.aborted) return
            const line = queue.shift()
            if (line) {
              yield line
              continue
            }
            if (stopped) return
            await new Promise<void>((resolve) => {
              wake = resolve
              signal.addEventListener("abort", () => resolve(), { once: true })
            })
          }
        })()
      },
    },
    get followers() {
      return signals.filter((signal) => !signal.aborted).length
    },
    stop() {
      stopped = true
      wake?.()
    },
    write(text: string, segments?: RelayConsoleLine["segments"]) {
      next += 1
      queue.push({
        id: String(next),
        level: "info",
        segments,
        text,
        timestamp: null,
      })
      wake?.()
    },
  }
}

// A Hearth page: collects the lines and ending pushed to it.
function page(accepting = true) {
  const pushes: Array<HearthDatabaseLogsOutput> = []
  return {
    pushes,
    get ended() {
      return pushes.find((push) => push.ended)?.ended ?? null
    },
    get lines() {
      return pushes.flatMap((push) => push.lines.map((line) => line.text))
    },
    push: async (output: HearthDatabaseLogsOutput) => {
      pushes.push(output)
      return { accepted: accepting }
    },
  }
}

describe("database logs", () => {
  it("sends a page the container's output in order, then that it stopped", async () => {
    const source = container()
    const logs = new DatabaseLogs(source.docker)
    const viewer = page()
    source.write("starting PostgreSQL")
    source.write("ready to accept connections")
    logs.attach(alice, database, "attachment-alice-0000000001", viewer.push)

    await vi.waitFor(() => expect(viewer.lines).toHaveLength(2))
    source.write("connection authorized")
    source.stop()

    await vi.waitFor(() => expect(viewer.ended).toBe("stopped"))
    expect(viewer.lines).toEqual([
      "starting PostgreSQL",
      "ready to accept connections",
      "connection authorized",
    ])
    expect(
      logs.heartbeat(alice, ["attachment-alice-0000000001"]).unknown
    ).toEqual(["attachment-alice-0000000001"])
  })

  it("keeps every push within a control frame, however styled its lines", async () => {
    const source = container()
    const logs = new DatabaseLogs(source.docker)
    const viewer = page()
    // Styling every character makes a line's encoding many times its text.
    const text = "x".repeat(16 * 1024)
    const segments = [...text].map((character) => ({
      bold: true,
      color: "#ff0000",
      text: character,
    }))
    for (let line = 0; line < 10; line += 1) source.write(text, segments)
    logs.attach(alice, database, "attachment-alice-0000000001", viewer.push)

    await vi.waitFor(() => expect(viewer.lines).toHaveLength(10))
    for (const push of viewer.pushes) {
      expect(Buffer.byteLength(JSON.stringify(push))).toBeLessThan(
        relayControlMaxFrameBytes
      )
    }
    expect(source.followers).toBe(1)
  })

  it("keeps each person's logs to themselves", async () => {
    const source = container()
    const logs = new DatabaseLogs(source.docker)
    logs.attach(alice, database, "attachment-alice-0000000001", page().push)

    expect(
      logs.heartbeat(mallory, ["attachment-alice-0000000001"]).unknown
    ).toEqual(["attachment-alice-0000000001"])
    logs.detach(mallory, "attachment-alice-0000000001")
    expect(source.followers).toBe(1)

    logs.detach(alice, "attachment-alice-0000000001")
    expect(source.followers).toBe(0)
  })

  it("stops following once Hearth no longer has the page", async () => {
    const source = container()
    const logs = new DatabaseLogs(source.docker)
    source.write("ready to accept connections")
    logs.attach(
      alice,
      database,
      "attachment-alice-0000000001",
      page(false).push
    )

    await vi.waitFor(() => expect(source.followers).toBe(0))
  })

  it("stops following a page Hearth stopped renewing", async () => {
    vi.useFakeTimers()
    const source = container()
    const logs = new DatabaseLogs(source.docker)
    logs.attach(alice, database, "attachment-alice-0000000001", page().push)
    logs.attach(alice, database, "attachment-alice-0000000002", page().push)

    for (let elapsed = 0; elapsed < FOLLOWER_EXPIRES_AFTER_MS;) {
      await vi.advanceTimersByTimeAsync(20_000)
      elapsed += 20_000
      logs.heartbeat(alice, ["attachment-alice-0000000002"])
    }
    await vi.advanceTimersByTimeAsync(20_000)

    expect(source.followers).toBe(1)
    expect(
      logs.heartbeat(alice, [
        "attachment-alice-0000000001",
        "attachment-alice-0000000002",
      ]).unknown
    ).toEqual(["attachment-alice-0000000001"])
  })
})
