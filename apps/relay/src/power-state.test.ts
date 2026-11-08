import { describe, expect, it } from "vite-plus/test"

import {
  observedServerPowerState,
  type ContainerPowerState,
  type ServerPowerTransition,
} from "./power-state.js"

// A started container counts as running once it has stayed up this long.
const INSTANCE_STARTUP_STABILITY_MS = 15_000
const startedAt = "2026-07-28T20:00:00.000Z"
const startedAtMs = Date.parse(startedAt)

function containerState(
  overrides: Partial<ContainerPowerState> = {}
): ContainerPowerState {
  return {
    ExitCode: 0,
    OOMKilled: false,
    Restarting: false,
    Running: true,
    StartedAt: startedAt,
    Status: "running",
    ...overrides,
  }
}

function transition(
  overrides: Partial<ServerPowerTransition> = {}
): ServerPowerTransition {
  return {
    action: "start",
    commandCompleted: true,
    initialStartedAt: null,
    requestedAt: startedAtMs,
    ...overrides,
  }
}

describe("instance power state", () => {
  it("keeps a newly started container in starting until it is stable", () => {
    expect(
      observedServerPowerState(
        containerState(),
        transition(),
        startedAtMs + INSTANCE_STARTUP_STABILITY_MS - 1
      )
    ).toEqual({
      observedState: "starting",
      transitionComplete: false,
    })

    expect(
      observedServerPowerState(
        containerState(),
        transition(),
        startedAtMs + INSTANCE_STARTUP_STABILITY_MS
      )
    ).toEqual({
      observedState: "running",
      transitionComplete: true,
    })
  })

  it("reports stopping until a graceful stop has actually completed", () => {
    const stopping = transition({
      action: "stop",
      commandCompleted: false,
      initialStartedAt: startedAt,
    })

    expect(
      observedServerPowerState(containerState(), stopping, startedAtMs)
    ).toEqual({
      observedState: "stopping",
      transitionComplete: false,
    })
    expect(
      observedServerPowerState(
        containerState({
          Running: false,
          StartedAt: "",
          Status: "exited",
        }),
        { ...stopping, commandCompleted: true },
        startedAtMs
      )
    ).toEqual({
      observedState: "stopped",
      transitionComplete: true,
    })
  })

  it("moves a restart from stopping to starting after Docker replaces the run", () => {
    const restarting = transition({
      action: "restart",
      commandCompleted: false,
      initialStartedAt: startedAt,
    })

    expect(
      observedServerPowerState(containerState(), restarting, startedAtMs)
        .observedState
    ).toBe("stopping")
    expect(
      observedServerPowerState(
        containerState({ StartedAt: "2026-07-28T20:00:02.000Z" }),
        restarting,
        startedAtMs + 2_000
      ).observedState
    ).toBe("starting")
  })
})
