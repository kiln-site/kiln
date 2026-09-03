import type { RelayObservedState } from "@workspace/contracts"
import type { IdentityStatusPresentation } from "@/components/identity-name"

export type InstanceStatusPresentation = IdentityStatusPresentation

export type RelayIdentityStatus =
  | "checking"
  | "connected"
  | "paused"
  | "unknown"
  | "unreachable"

export interface RelayStatusSource {
  connected?: boolean
  enabled?: boolean
  lastError?: string | null
  relayStatus?: RelayIdentityStatus
}

interface InstanceIdentity {
  id: string
  relayId: string
}

export type InstanceNameInstance =
  | (InstanceIdentity & {
      brickId?: string
      brickSource?: string
      implementation?: string
      kind: "server"
      observedState?: RelayObservedState
      relayStatus?: "connected" | "unreachable"
    })
  | (InstanceIdentity & {
      kind: "relay"
      source?: "fleet" | "registry"
    } & RelayStatusSource)
  | (InstanceIdentity & {
      inventoryStatus?: "available" | "missing" | "unavailable"
      kind: "database"
      observedState?: RelayObservedState
    })

export function instanceStatusPresentation(
  instance: InstanceNameInstance
): InstanceStatusPresentation {
  if (instance.kind === "server") {
    if (instance.relayStatus === "unreachable") {
      return { label: "Relay unavailable", tone: "danger" }
    }
    return instance.observedState
      ? observedStatus(instance.observedState)
      : { label: "Status unavailable", tone: "neutral" }
  }
  if (instance.kind === "relay") {
    return relayStatusPresentation(instance)
  }
  if (instance.inventoryStatus === "missing") {
    return { label: "Missing", tone: "danger" }
  }
  if (instance.inventoryStatus === "unavailable") {
    return { label: "Unavailable", tone: "warning" }
  }
  return instance.observedState
    ? observedStatus(instance.observedState)
    : { label: "Status unavailable", tone: "neutral" }
}

export function relayStatusPresentation(
  relay: RelayStatusSource
): InstanceStatusPresentation {
  if (relay.enabled === false || relay.relayStatus === "paused") {
    return { label: "Paused", tone: "info" }
  }
  if (relay.relayStatus === "checking") {
    return { label: "Checking", tone: "neutral" }
  }
  if (relay.relayStatus === "unreachable") {
    return { label: "Unreachable", tone: "danger" }
  }
  if (relay.relayStatus === "connected") {
    return { label: "Online", tone: "success" }
  }
  if (relay.relayStatus === "unknown") {
    return { label: "Unknown", tone: "neutral" }
  }
  if (relay.lastError) return { label: "Unreachable", tone: "danger" }
  if (relay.connected) return { label: "Online", tone: "success" }
  return { label: "Offline", tone: "neutral" }
}

function observedStatus(state: RelayObservedState): InstanceStatusPresentation {
  if (state === "running") return { label: "Running", tone: "success" }
  if (state === "failed") return { label: "Failed", tone: "danger" }
  if (state === "starting" || state === "provisioning") {
    return {
      label: state === "starting" ? "Starting" : "Provisioning",
      tone: "warning",
    }
  }
  if (state === "stopping") return { label: "Stopping", tone: "warning" }
  return { label: "Stopped", tone: "neutral" }
}
