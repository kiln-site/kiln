import type {
  RelayInstanceRecovery,
  RelayInstanceStateReason,
  RelayDesiredState,
  RelayObservedState,
} from "@workspace/contracts"

const INSTANCE_STARTUP_STABILITY_MS = 15_000
export const INSTANCE_STARTUP_READINESS_TIMEOUT_MS = 120_000
export const INSTANCE_STOP_TIMEOUT_SECONDS = 60

export type InstancePowerAction = "start" | "stop" | "restart" | "kill"

export interface ContainerPowerState {
  ExitCode: number
  Health?: {
    Status: string
  }
  OOMKilled: boolean
  Restarting: boolean
  Running: boolean
  StartedAt: string
  Status: string
}

export interface InstancePowerTransition {
  action: InstancePowerAction
  commandCompleted: boolean
  initialStartedAt: string | null
  requestedAt: number
}

export interface ObservedInstancePowerState {
  observedState: RelayObservedState
  transitionComplete: boolean
}

export function observedInstancePowerState(
  state: ContainerPowerState,
  transition: InstancePowerTransition | undefined,
  now = Date.now(),
  ready?: boolean
): ObservedInstancePowerState {
  if (!transition) {
    return {
      observedState: observedContainerState(state, now, ready),
      transitionComplete: false,
    }
  }

  if (transition.action === "stop" || transition.action === "kill") {
    return state.Running
      ? { observedState: "stopping", transitionComplete: false }
      : {
          observedState: stoppedContainerState(state),
          transitionComplete: true,
        }
  }

  if (transition.action === "restart") {
    const replacementStarted =
      state.Running &&
      state.StartedAt !== transition.initialStartedAt &&
      state.StartedAt.length > 0
    if (!replacementStarted && !transition.commandCompleted) {
      return { observedState: "stopping", transitionComplete: false }
    }
  }

  if (!state.Running) {
    return transition.commandCompleted
      ? {
          observedState: stoppedContainerState(state),
          transitionComplete: true,
        }
      : { observedState: "starting", transitionComplete: false }
  }

  if (state.Restarting || state.Status === "restarting") {
    return { observedState: "starting", transitionComplete: false }
  }

  if (ready === true || state.Health?.Status === "healthy") {
    return { observedState: "running", transitionComplete: true }
  }
  if (state.Health?.Status === "unhealthy") {
    return { observedState: "failed", transitionComplete: true }
  }
  if (state.Health?.Status === "starting") {
    return { observedState: "starting", transitionComplete: false }
  }

  const startedAt = Date.parse(state.StartedAt)
  const stableSince = Number.isFinite(startedAt)
    ? startedAt
    : transition.requestedAt
  const runningFor = now - stableSince
  if (ready === false && runningFor < INSTANCE_STARTUP_READINESS_TIMEOUT_MS) {
    return { observedState: "starting", transitionComplete: false }
  }
  return runningFor >= INSTANCE_STARTUP_STABILITY_MS
    ? { observedState: "running", transitionComplete: true }
    : { observedState: "starting", transitionComplete: false }
}

export function instanceStateReason(
  state: ContainerPowerState,
  observedState: RelayObservedState,
  ready?: boolean,
  recovery?: RelayInstanceRecovery | null,
  desiredState?: RelayDesiredState
): RelayInstanceStateReason | null {
  if (recovery) {
    return {
      code: "automatic_recovery",
      exitCode: recovery.exitCode,
      phase: recovery.phase,
      reason: recovery.reason,
    }
  }
  if (state.Restarting || state.Status === "restarting") {
    return { code: "container_restarting" }
  }
  if (state.Health?.Status === "unhealthy") {
    return { code: "health_check_failed" }
  }
  if (state.Health?.Status === "starting") {
    return { code: "health_check_starting" }
  }
  if (observedState === "starting" && ready === false) {
    return { code: "waiting_for_readiness" }
  }
  if (observedState !== "failed") return null
  if (state.OOMKilled) {
    return {
      code:
        desiredState === "stopped"
          ? "out_of_memory_while_stopping"
          : "out_of_memory",
    }
  }
  if (state.ExitCode !== 0 && state.ExitCode !== 143) {
    return { code: "process_exit", exitCode: state.ExitCode }
  }
  return { code: "unknown" }
}

function observedContainerState(
  state: ContainerPowerState,
  now: number,
  ready?: boolean
): RelayObservedState {
  if (state.Restarting || state.Status === "restarting") return "starting"
  if (state.Running) {
    if (ready === true || state.Health?.Status === "healthy") return "running"
    if (state.Health?.Status === "unhealthy") return "failed"
    if (state.Health?.Status === "starting") return "starting"
    const startedAt = Date.parse(state.StartedAt)
    const runningFor = Number.isFinite(startedAt)
      ? now - startedAt
      : INSTANCE_STARTUP_READINESS_TIMEOUT_MS
    if (ready === false) {
      return runningFor < INSTANCE_STARTUP_READINESS_TIMEOUT_MS
        ? "starting"
        : "running"
    }
    return runningFor < INSTANCE_STARTUP_STABILITY_MS ? "starting" : "running"
  }
  return stoppedContainerState(state)
}

function stoppedContainerState(state: ContainerPowerState): RelayObservedState {
  if (state.OOMKilled) return "failed"
  return state.ExitCode === 0 || state.ExitCode === 143 ? "stopped" : "failed"
}
