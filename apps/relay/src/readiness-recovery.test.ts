import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { fakeDocker } from "./test/docker.js"
import { relayHarness, serverRecipe, type RelayHarness } from "./test/relay.js"

const id = "a".repeat(40)

/** A server whose Brick declares readiness only in its recipe (legacy labels). */
async function legacyServer(
  harness: RelayHarness,
  readinessLogs: Array<string> | undefined,
  seed: { logs: Array<{ text: string; time: string }>; startedAt: string }
) {
  const recipe = serverRecipe(
    readinessLogs ? { readiness: { logs: readinessLogs } } : {}
  )
  const source = await harness.publishRecipe(recipe)
  const snapshot = await harness.bricks.saveSnapshot(recipe)
  return harness.seedServer({
    id,
    labels: {
      "kiln.brick.snapshot-sha256": snapshot,
      "kiln.brick.source": source,
    },
    running: true,
    ...seed,
  })
}

const storedLifecycle = (harness: RelayHarness) =>
  Effect.runPromise(harness.state.listLifecycleSessions()).then(
    (sessions) => sessions.find((session) => session.instanceId === id)?.events
  )

describe("rediscovered startup readiness", () => {
  it("recovers a ready event older than the console tail and keeps it across restarts and exits", async () => {
    const harness = await relayHarness()
    const startedAt = "2026-08-21T20:39:57.000Z"
    const readyAt = "2026-08-21T20:40:19.000Z"
    const container = await legacyServer(harness, [")! For help, type "], {
      logs: [
        {
          text: '\u001b[32mDone (21.758s)! For help, type "help"\u001b[0m',
          time: readyAt,
        },
        // Push the ready line well beyond the recent console history.
        ...Array.from({ length: 6_000 }, (_, index) => ({
          text: `later output ${index}`,
          time: new Date(Date.parse(readyAt) + index + 1).toISOString(),
        })),
      ],
      startedAt,
    })
    const ready = [
      { state: "started", time: startedAt },
      { state: "ready", time: readyAt },
    ]

    const [instance] = await harness.docker.inspectInstances()

    expect(instance).toMatchObject({ lifecycle: ready, observedState: "running" })
    expect(await storedLifecycle(harness)).toEqual(ready)

    // After a Relay restart the session comes from state, even once Docker
    // has rotated the startup logs away.
    container.logs = []
    const [afterRelayRestart] = await (
      await harness.restart()
    ).docker.inspectInstances()
    expect(afterRelayRestart).toMatchObject({
      lifecycle: ready,
      observedState: "running",
    })

    const restarted = await harness.restart()
    const config = await restarted.docker.findInstance(id)
    if (!config) throw new Error("Server was not discovered")
    const afterServerStop = await restarted.docker.runAction(config, "stop")
    expect(afterServerStop.observedState).toBe("stopped")
    expect(afterServerStop.lifecycle.slice(0, 2)).toEqual(ready)
    expect(afterServerStop.lifecycle.at(-1)).toEqual({
      state: "stopped",
      time: container.state.finishedAt,
    })
    // Stored events are ordered by time only; a same-millisecond stop may
    // come back in either order.
    const stored = await storedLifecycle(harness)
    expect(stored).toHaveLength(afterServerStop.lifecycle.length)
    expect(stored).toEqual(expect.arrayContaining(afterServerStop.lifecycle))
  })

  it("recovers readiness for a session that crashed before Relay saw it", async () => {
    const harness = await relayHarness()
    const startedAt = "2026-08-22T00:00:00.000Z"
    const readyAt = "2026-08-22T00:00:20.000Z"
    const failedAt = "2026-08-22T00:12:30.000Z"
    const container = await legacyServer(harness, [")! For help, type "], {
      logs: [{ text: 'Done (20.000s)! For help, type "help"', time: readyAt }],
      startedAt,
    })
    fakeDocker.exit(container.name, { exitCode: 137, oomKilled: true })
    container.state.finishedAt = failedAt

    const [instance] = await harness.docker.inspectInstances()

    expect(instance?.observedState).toBe("failed")
    expect(instance?.lifecycle).toEqual([
      { state: "started", time: startedAt },
      { state: "ready", time: readyAt },
      { state: "failed", time: failedAt },
    ])
  })

  it("keeps readiness unknown for a legacy session whose Brick has no ready log", async () => {
    const harness = await relayHarness()
    const startedAt = "2026-08-21T20:39:57.000Z"
    await legacyServer(harness, undefined, {
      logs: [{ text: 'Done (21.758s)! For help, type "help"', time: startedAt }],
      startedAt,
    })

    const [instance] = await harness.docker.inspectInstances()

    expect(instance).toMatchObject({
      lifecycle: [{ state: "started", time: startedAt }],
      observedState: "running",
    })
    expect(await storedLifecycle(harness)).toEqual([
      { state: "started", time: startedAt },
    ])
  })
})
