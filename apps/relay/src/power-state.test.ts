import { describe, expect, it } from "vite-plus/test"

import {
  INSTANCE_STARTUP_READINESS_TIMEOUT_MS,
  instanceStateReason,
  observedInstancePowerState,
  type ContainerPowerState,
  type InstancePowerTransition,
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
  overrides: Partial<InstancePowerTransition> = {}
): InstancePowerTransition {
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
      observedInstancePowerState(
        containerState(),
        transition(),
        startedAtMs + INSTANCE_STARTUP_STABILITY_MS - 1
      )
    ).toEqual({
      observedState: "starting",
      transitionComplete: false,
    })

    expect(
      observedInstancePowerState(
        containerState(),
        transition(),
        startedAtMs + INSTANCE_STARTUP_STABILITY_MS
      )
    ).toEqual({
      observedState: "running",
      transitionComplete: true,
    })
  })

  it("uses Docker health as the readiness signal when one exists", () => {
    expect(
      observedInstancePowerState(
        containerState({ Health: { Status: "starting" } }),
        transition(),
        startedAtMs + INSTANCE_STARTUP_STABILITY_MS * 2
      )
    ).toEqual({
      observedState: "starting",
      transitionComplete: false,
    })

    expect(
      observedInstancePowerState(
        containerState({ Health: { Status: "healthy" } }),
        transition(),
        startedAtMs + 1
      )
    ).toEqual({
      observedState: "running",
      transitionComplete: true,
    })

    expect(
      observedInstancePowerState(
        containerState({ Health: { Status: "unhealthy" } }),
        transition(),
        startedAtMs + 1
      )
    ).toEqual({
      observedState: "failed",
      transitionComplete: true,
    })
  })

  it("waits for a declared service port without depending on console text", () => {
    const state = containerState()
    const observed = observedInstancePowerState(
      state,
      transition(),
      startedAtMs + INSTANCE_STARTUP_STABILITY_MS * 2,
      false
    )
    expect(observed).toEqual({
      observedState: "starting",
      transitionComplete: false,
    })
    expect(instanceStateReason(state, observed.observedState, false)).toEqual({
      code: "waiting_for_readiness",
    })
    expect(
      observedInstancePowerState(
        containerState(),
        transition(),
        startedAtMs + 1,
        true
      )
    ).toEqual({
      observedState: "running",
      transitionComplete: true,
    })
    expect(
      observedInstancePowerState(
        containerState(),
        transition(),
        startedAtMs + INSTANCE_STARTUP_READINESS_TIMEOUT_MS,
        false
      )
    ).toEqual({
      observedState: "running",
      transitionComplete: true,
    })
  })

  it("recovers startup readiness after the Relay process restarts", () => {
    expect(
      observedInstancePowerState(
        containerState(),
        undefined,
        startedAtMs + INSTANCE_STARTUP_STABILITY_MS * 2,
        false
      )
    ).toEqual({
      observedState: "starting",
      transitionComplete: false,
    })
    expect(
      observedInstancePowerState(
        containerState(),
        undefined,
        startedAtMs + INSTANCE_STARTUP_STABILITY_MS * 2,
        true
      )
    ).toEqual({
      observedState: "running",
      transitionComplete: false,
    })
  })

  it("reports stopping until a graceful stop has actually completed", () => {
    const stopping = transition({
      action: "stop",
      commandCompleted: false,
      initialStartedAt: startedAt,
    })

    expect(
      observedInstancePowerState(containerState(), stopping, startedAtMs)
    ).toEqual({
      observedState: "stopping",
      transitionComplete: false,
    })
    expect(
      observedInstancePowerState(
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
      observedInstancePowerState(containerState(), restarting, startedAtMs)
        .observedState
    ).toBe("stopping")
    expect(
      observedInstancePowerState(
        containerState({ StartedAt: "2026-07-28T20:00:02.000Z" }),
        restarting,
        startedAtMs + 2_000
      ).observedState
    ).toBe("starting")
  })

  it("reports Docker and managed recovery phases separately", () => {
    const state = containerState({ Restarting: true, Status: "restarting" })
    expect(instanceStateReason(state, "starting")).toEqual({
      code: "container_restarting",
    })
    expect(
      instanceStateReason(state, "starting", undefined, {
        attempt: 2,
        exitCode: 1,
        maxAttempts: 3,
        nextAttemptAt: null,
        oomKilled: false,
        phase: "restarting",
        reason: "process_exit",
        runtimeMs: 4_000,
      })
    ).toEqual({
      code: "automatic_recovery",
      exitCode: 1,
      phase: "restarting",
      reason: "process_exit",
    })
  })

  it("does not infer whether stopped intent preceded an OOM kill", () => {
    const oomKilled = containerState({ OOMKilled: true, Running: false })

    expect(
      instanceStateReason(oomKilled, "failed", undefined, null, "running")
    ).toEqual({ code: "out_of_memory" })
    expect(
      instanceStateReason(
        oomKilled,
        "failed",
        undefined,
        null,
        "stopped"
      )
    ).toEqual({ code: "out_of_memory_while_stopping" })
  })
})
