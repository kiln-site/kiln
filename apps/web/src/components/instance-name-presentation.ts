import type { RelayObservedState } from "@workspace/contracts"

import type { BrickIconPresentation } from "@/components/brick-icon"

export interface InstanceStatusPresentation {
  label: string
  tone: "danger" | "info" | "neutral" | "success" | "warning"
}

interface InstanceIdentity {
  id: string
  relayId: string
}

export type InstanceNameInstance =
  | (InstanceIdentity & {
      icon?: BrickIconPresentation
      kind: "server"
      observedState?: RelayObservedState
      relayStatus?: "connected" | "unreachable"
    })
  | (InstanceIdentity & {
      connected?: boolean
      enabled?: boolean
      kind: "relay"
      lastError?: string | null
      relayStatus?: "connected" | "unreachable"
      source?: "fleet" | "registry"
    })
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
    if (instance.enabled === false) return { label: "Paused", tone: "info" }
    if (instance.lastError || instance.relayStatus === "unreachable") {
      return { label: "Unreachable", tone: "danger" }
    }
    if (instance.connected || instance.relayStatus === "connected") {
      return { label: "Online", tone: "success" }
    }
    return { label: "Offline", tone: "neutral" }
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
