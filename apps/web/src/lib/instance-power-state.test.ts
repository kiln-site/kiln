import { describe, expect, it } from "vite-plus/test"
import { relayInstanceSchema } from "@workspace/contracts"

import {
  beginPendingPowerAction,
  finishPendingPowerAction,
  initialPendingPowerAction,
  isPowerControlLocked,
  reconcilePendingPowerInstance,
  reconcilePendingPowerState,
} from "./instance-power-state"

describe("pending instance power state", () => {
  it("locks power actions while an instance is provisioning", () => {
    expect(isPowerControlLocked("provisioning")).toBe(true)
    expect(isPowerControlLocked("stopped")).toBe(false)
    expect(isPowerControlLocked("running")).toBe(false)
  })

  it("advances the registered action from its response before a stale stream", () => {
    const relayId = "relay"
    const running = relayInstanceSchema.parse({
      id: "a".repeat(40),
      shortId: "a".repeat(8),
      name: "Power test",
      game: "Minecraft",
      implementation: "Paper",
      version: "1.21.11",
      javaVersion: "21",
      connectAddress: "power.test",
      service: "power-test",
      directory: "/srv/power-test",
      desiredState: "running",
      observedState: "running",
      lifecycle: [
        { state: "started", time: "2026-07-28T20:00:00.000Z" },
        { state: "ready", time: "2026-07-28T20:00:15.000Z" },
      ],
      containerId: "container",
      status: "Running",
    })
    beginPendingPowerAction(relayId, running.id, "stop")

    try {
      const actionResponse = reconcilePendingPowerInstance(relayId, {
        ...running,
        desiredState: "stopped",
        observedState: "stopped",
        status: "Exited (143)",
      })
      const staleStream = reconcilePendingPowerInstance(relayId, running)
      const confirmation = reconcilePendingPowerInstance(
        relayId,
        actionResponse
      )
      const afterConfirmation = reconcilePendingPowerInstance(relayId, running)

      expect(actionResponse.observedState).toBe("stopped")
      expect(staleStream.observedState).toBe("stopped")
      expect(confirmation.observedState).toBe("stopped")
      expect(afterConfirmation.observedState).toBe("running")
    } finally {
      finishPendingPowerAction(relayId, running.id)
    }
  })

  it("protects a transitional start until running is confirmed", () => {
    const relayId = "relay"
    const stopped = relayInstanceSchema.parse({
      id: "b".repeat(40),
      shortId: "b".repeat(8),
      name: "Start test",
      game: "Minecraft",
      implementation: "Paper",
      version: "1.21.11",
      javaVersion: "21",
      connectAddress: "start.test",
      service: "start-test",
      directory: "/srv/start-test",
      desiredState: "stopped",
      observedState: "stopped",
      containerId: "container",
      status: "Exited (143)",
    })
    const startedAt = "2026-07-28T21:00:00.000Z"
    const starting = relayInstanceSchema.parse({
      ...stopped,
      desiredState: "running",
      observedState: "starting",
      lifecycle: [{ state: "started", time: startedAt }],
      status: "Starting",
    })
    const running = relayInstanceSchema.parse({
      ...starting,
      observedState: "running",
      status: "Running",
    })
    beginPendingPowerAction(relayId, stopped.id, "start")

    try {
      const actionResponse = reconcilePendingPowerInstance(relayId, starting)
      const stalePoll = reconcilePendingPowerInstance(relayId, stopped)
      const ready = reconcilePendingPowerInstance(relayId, running)
      const staleAfterReady = reconcilePendingPowerInstance(relayId, stopped)
      const confirmation = reconcilePendingPowerInstance(relayId, running)
      const afterConfirmation = reconcilePendingPowerInstance(relayId, stopped)

      expect(actionResponse.observedState).toBe("starting")
      expect(stalePoll.observedState).toBe("starting")
      expect(ready.observedState).toBe("running")
      expect(staleAfterReady.observedState).toBe("running")
      expect(confirmation.observedState).toBe("running")
      expect(afterConfirmation.observedState).toBe("stopped")
    } finally {
      finishPendingPowerAction(relayId, stopped.id)
    }
  })

  it("accepts a replacement running snapshot when restart skips starting", () => {
    const relayId = "relay"
    const previous = relayInstanceSchema.parse({
      id: "c".repeat(40),
      shortId: "c".repeat(8),
      name: "Restart test",
      game: "Minecraft",
      implementation: "Paper",
      version: "1.21.11",
      javaVersion: "21",
      connectAddress: "restart.test",
      service: "restart-test",
      directory: "/srv/restart-test",
      desiredState: "running",
      observedState: "running",
      lifecycle: [
        { state: "started", time: "2026-07-28T20:00:00.000Z" },
        { state: "ready", time: "2026-07-28T20:00:15.000Z" },
      ],
      containerId: "container",
      status: "Running",
    })
    const replacementStartedAt = "2026-07-28T21:00:00.000Z"
    const replacement = relayInstanceSchema.parse({
      ...previous,
      observedState: "starting",
      lifecycle: [{ state: "started", time: replacementStartedAt }],
      status: "Starting",
    })
    const ready = relayInstanceSchema.parse({
      ...replacement,
      observedState: "running",
      status: "Running",
    })
    beginPendingPowerAction(
      relayId,
      previous.id,
      "restart",
      "2026-07-28T20:00:00.000Z"
    )

    try {
      expect(
        reconcilePendingPowerInstance(relayId, previous).observedState
      ).toBe("stopping")
      expect(reconcilePendingPowerInstance(relayId, ready).observedState).toBe(
        "running"
      )
      expect(
        reconcilePendingPowerInstance(relayId, previous).observedState
      ).toBe("running")
      expect(reconcilePendingPowerInstance(relayId, ready).observedState).toBe(
        "running"
      )
      expect(
        reconcilePendingPowerInstance(relayId, {
          ...previous,
          desiredState: "stopped",
          observedState: "stopped",
          lifecycle: [
            ...previous.lifecycle,
            { state: "stopped", time: "2026-07-28T21:01:00.000Z" },
          ],
          status: "Exited (143)",
        }).observedState
      ).toBe("stopped")
    } finally {
      finishPendingPowerAction(relayId, previous.id)
    }
  })

  it("latches a completed stop response before stale stream snapshots", () => {
    const stopping = initialPendingPowerAction("stop")
    const actionResponse = reconcilePendingPowerState(stopping, "stopped")
    const staleStream = reconcilePendingPowerState(
      actionResponse.pending,
      "running"
    )

    expect(reconcilePendingPowerState(stopping, "running").observedState).toBe(
      "stopping"
    )
    expect(actionResponse.observedState).toBe("stopped")
    expect(staleStream.observedState).toBe("stopped")
  })

  it("does not let stale snapshots move a start backwards", () => {
    const starting = initialPendingPowerAction("start")
    const running = reconcilePendingPowerState(starting, "running")

    expect(reconcilePendingPowerState(starting, "stopped").observedState).toBe(
      "starting"
    )
    expect(running.observedState).toBe("running")
    expect(
      reconcilePendingPowerState(running.pending, "stopped").observedState
    ).toBe("running")
  })

  it("moves restart snapshots from stopping to starting before running", () => {
    const previousStartedAt = "2026-07-28T20:00:00.000Z"
    const replacementStartedAt = "2026-07-28T21:00:00.000Z"
    const stopping = initialPendingPowerAction("restart", previousStartedAt)
    const replacement = reconcilePendingPowerState(
      stopping,
      "starting",
      replacementStartedAt
    )

    expect(
      reconcilePendingPowerState(stopping, "running", previousStartedAt)
        .observedState
    ).toBe("stopping")
    expect(
      reconcilePendingPowerState(stopping, "running", replacementStartedAt)
        .observedState
    ).toBe("running")
    expect(replacement.observedState).toBe("starting")
    expect(
      reconcilePendingPowerState(
        replacement.pending,
        "running",
        previousStartedAt
      ).observedState
    ).toBe("starting")
    expect(
      reconcilePendingPowerState(
        replacement.pending,
        "running",
        replacementStartedAt
      ).observedState
    ).toBe("running")
  })
})
