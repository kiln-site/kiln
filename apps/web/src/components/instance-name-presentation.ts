import type { RelayObservedState } from "@workspace/contracts"
import type { IdentityStatusPresentation } from "@/components/identity-name"

export type InstanceStatusPresentation = IdentityStatusPresentation

// Status columns hug their longest label, "Unreachable" (5.18rem with its
// dot), plus the cells' 0.75rem horizontal padding.
export const statusColumnWidth = "6.7rem"

export type RelayIdentityStatus =
  | "checking"
  | "connected"
  | "paused"
  // Paused in Hearth, but the Relay hasn't confirmed it holds the pause.
  | "pausing"
  | "unknown"
  | "unreachable"

export interface RelayStatusSource {
  connected?: boolean
  enabled?: boolean
  lastError?: string | null
  relayStatus?: RelayIdentityStatus
  updating?: boolean
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
      relayUpdating?: boolean
    })
  | (InstanceIdentity & {
      kind: "relay"
      /** Kiln itself, backed up on and reached through this Relay. */
      platform?: boolean
      source?: "fleet" | "registry"
    } & RelayStatusSource)
  | (InventoryIdentity & { kind: "database" })
  | (InventoryIdentity & { kind: "app" })

// Databases and apps: what their Relay's inventory last reported.
interface InventoryIdentity extends InstanceIdentity {
  inventoryStatus?: "available" | "missing" | "unavailable"
  observedState?: RelayObservedState
  relayStatus?: "connected" | "unreachable"
  relayUpdating?: boolean
}

export function instanceStatusPresentation(
  instance: InstanceNameInstance
): InstanceStatusPresentation {
  if (instance.kind === "relay") return relayStatusPresentation(instance)
  if (instance.kind === "server") {
    return workloadStatusPresentation({
      observedState: instance.observedState,
      relayReachable: instance.relayStatus !== "unreachable",
      relayUpdating: instance.relayUpdating === true,
    })
  }
  const inventoried = instance.inventoryStatus !== "unavailable"
  return workloadStatusPresentation({
    missing: instance.inventoryStatus === "missing",
    // Hearth only has a placeholder state for databases it cannot inventory.
    observedState: inventoried ? instance.observedState : undefined,
    relayReachable: inventoried && instance.relayStatus !== "unreachable",
    relayUpdating: instance.relayUpdating === true,
  })
}

export function relayStatusPresentation(
  relay: RelayStatusSource
): InstanceStatusPresentation {
  if (relay.relayStatus === "pausing") {
    return {
      detail: "Waiting for the Relay to confirm it's paused",
      label: "Pausing",
      pulse: true,
      tone: "warning",
    }
  }
  if (
    relay.relayStatus === "paused" ||
    (relay.enabled === false && relay.relayStatus === undefined)
  ) {
    return { label: "Paused", tone: "neutral" }
  }
  if (relay.updating) {
    return { label: "Updating", pulse: true, tone: "info" }
  }
  if (relay.relayStatus === "checking") {
    return { label: "Checking", pending: true, pulse: true, tone: "neutral" }
  }
  if (
    relay.relayStatus === "unreachable" ||
    (relay.relayStatus === undefined && relay.lastError)
  ) {
    return {
      detail: relay.lastError ?? undefined,
      label: "Unreachable",
      tone: "danger",
    }
  }
  if (
    relay.relayStatus === "connected" ||
    (relay.relayStatus === undefined && relay.connected)
  ) {
    return { label: "Online", tone: "success" }
  }
  return { label: "Unknown", tone: "neutral" }
}

// Workloads keep running while their Relay is away, so the last observed
// state stays available as detail rather than being replaced outright.
function workloadStatusPresentation({
  missing = false,
  observedState,
  relayReachable,
  relayUpdating,
}: {
  missing?: boolean
  observedState: RelayObservedState | undefined
  relayReachable: boolean
  relayUpdating: boolean
}): InstanceStatusPresentation {
  if (!relayReachable) {
    const lastSeen = observedState
      ? ` · last seen ${observedStatus(observedState).label}`
      : ""
    return relayUpdating
      ? {
          detail: `Relay updating${lastSeen}`,
          label: "Updating",
          pulse: true,
          tone: "info",
        }
      : {
          detail: `Relay unreachable${lastSeen}`,
          label: "Unreachable",
          tone: "danger",
        }
  }
  if (missing) {
    return {
      detail: "Container is missing from the Relay",
      label: "Missing",
      tone: "danger",
    }
  }
  return observedState
    ? observedStatus(observedState)
    : { label: "Unknown", tone: "neutral" }
}

function observedStatus(state: RelayObservedState): InstanceStatusPresentation {
  if (state === "running") return { label: "Running", tone: "success" }
  if (state === "failed") return { label: "Failed", tone: "danger" }
  if (state === "starting") {
    return { label: "Starting", pulse: true, tone: "warning" }
  }
  if (state === "provisioning") {
    return { label: "Creating", pulse: true, tone: "warning" }
  }
  if (state === "stopping") {
    return { label: "Stopping", pulse: true, tone: "warning" }
  }
  return { label: "Stopped", tone: "neutral" }
}
