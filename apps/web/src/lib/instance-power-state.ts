import type { RelayInstance, RelayObservedState } from "@workspace/contracts"
import { relayInstanceLifecycleEventTime } from "@workspace/contracts"

import type { RelayFleetSnapshot } from "@/lib/relay-fleet"

export type ServerAction = "start" | "stop" | "restart" | "kill"

export interface PendingPowerAction {
  action: ServerAction
  initialStartedAt: string | null
  phase: "starting" | "stopping" | "running" | "stopped" | "failed"
  terminalStartedAt: string | null
}

const pendingPowerActions = new Map<string, PendingPowerAction>()

export function isPowerControlLocked(
  observedState: RelayObservedState
): boolean {
  return observedState === "provisioning"
}

export function beginPendingPowerAction(
  relayId: string,
  instanceId: string,
  action: ServerAction,
  initialStartedAt: string | null = null
): PendingPowerAction {
  const pending = initialPendingPowerAction(action, initialStartedAt)
  pendingPowerActions.set(powerActionKey(relayId, instanceId), pending)
  return pending
}

export function finishPendingPowerAction(relayId: string, instanceId: string) {
  pendingPowerActions.delete(powerActionKey(relayId, instanceId))
}

export function reconcilePendingPowerInstance<T extends RelayInstance>(
  relayId: string,
  instance: T
): T {
  const key = powerActionKey(relayId, instance.id)
  const pending = pendingPowerActions.get(key)
  if (!pending) return instance

  const reconciled = reconcilePendingPowerState(
    pending,
    instance.observedState,
    relayInstanceLifecycleEventTime(instance.lifecycle, "started")
  )
  const terminalConfirmed =
    isTerminalPowerPhase(pending.phase) &&
    instance.observedState === pending.phase &&
    relayInstanceLifecycleEventTime(instance.lifecycle, "started") ===
      pending.terminalStartedAt
  if (terminalConfirmed) {
    pendingPowerActions.delete(key)
  } else {
    pendingPowerActions.set(key, reconciled.pending)
  }
  return reconciled.observedState === instance.observedState
    ? instance
    : { ...instance, observedState: reconciled.observedState }
}

export function reconcilePendingPowerSnapshot(
  snapshot: RelayFleetSnapshot
): RelayFleetSnapshot {
  let changed = false
  const instances = snapshot.instances.map((instance) => {
    const reconciled = reconcilePendingPowerInstance(instance.relayId, instance)
    if (reconciled !== instance) changed = true
    return reconciled
  })
  return changed ? { ...snapshot, instances } : snapshot
}

export function initialPendingPowerAction(
  action: ServerAction,
  initialStartedAt: string | null = null
): PendingPowerAction {
  return {
    action,
    initialStartedAt,
    phase: action === "start" ? "starting" : "stopping",
    terminalStartedAt: null,
  }
}

export function reconcilePendingPowerState(
  pending: PendingPowerAction,
  incoming: RelayObservedState,
  incomingStartedAt: string | null = null
): {
  pending: PendingPowerAction
  observedState: RelayObservedState
} {
  if (isTerminalPowerPhase(pending.phase)) {
    return { pending, observedState: pending.phase }
  }

  if (pending.action === "stop" || pending.action === "kill") {
    if (incoming === "stopped" || incoming === "failed") {
      const completed: PendingPowerAction = {
        ...pending,
        phase: incoming,
        terminalStartedAt: incomingStartedAt,
      }
      return { pending: completed, observedState: incoming }
    }
    return { pending, observedState: "stopping" }
  }

  if (pending.action === "start") {
    if (incoming === "running" || incoming === "failed") {
      const completed: PendingPowerAction = {
        ...pending,
        phase: incoming,
        terminalStartedAt: incomingStartedAt,
      }
      return { pending: completed, observedState: incoming }
    }
    return { pending, observedState: "starting" }
  }

  if (pending.phase === "stopping") {
    if (incoming === "starting") {
      const starting: PendingPowerAction = { ...pending, phase: "starting" }
      return { pending: starting, observedState: "starting" }
    }
    if (
      incoming === "running" &&
      incomingStartedAt !== null &&
      incomingStartedAt !== pending.initialStartedAt
    ) {
      const running: PendingPowerAction = {
        ...pending,
        phase: "running",
        terminalStartedAt: incomingStartedAt,
      }
      return { pending: running, observedState: "running" }
    }
    if (incoming === "failed") {
      const failed: PendingPowerAction = {
        ...pending,
        phase: "failed",
        terminalStartedAt: incomingStartedAt,
      }
      return { pending: failed, observedState: "failed" }
    }
    return { pending, observedState: "stopping" }
  }

  if (
    incoming === "running" &&
    (incomingStartedAt === null ||
      incomingStartedAt === pending.initialStartedAt)
  ) {
    return { pending, observedState: "starting" }
  }
  if (incoming === "running" || incoming === "failed") {
    const completed: PendingPowerAction = {
      ...pending,
      phase: incoming,
      terminalStartedAt: incomingStartedAt,
    }
    return { pending: completed, observedState: incoming }
  }
  return { pending, observedState: "starting" }
}

function isTerminalPowerPhase(phase: PendingPowerAction["phase"]) {
  return phase === "running" || phase === "stopped" || phase === "failed"
}

function powerActionKey(relayId: string, instanceId: string) {
  return `${relayId}:${instanceId}`
}
