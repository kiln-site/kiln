import type { IdentityStatusPresentation } from "@/components/identity-name"
import { instanceStatusPresentation } from "@/components/instance-name-presentation"
import type { InstanceState } from "@/lib/instance-state"

export function instanceStatePresentation(
  state: InstanceState
): IdentityStatusPresentation {
  if (state.phase === "checking")
    return { label: "Checking", tone: "neutral", pulse: true }
  if (state.phase === "error")
    return { label: "Unknown", detail: state.error.message, tone: "neutral" }
  const { observation } = state
  if (observation.kind === "relay") {
    return instanceStatusPresentation({
      ...observation,
      kind: "relay",
      relayStatus: observation.reachability,
      updating: observation.updating,
    })
  }
  if (observation.reachability === "checking")
    return { label: "Checking", tone: "neutral", pulse: true }
  if (observation.reachability === "paused")
    return { label: "Paused", tone: "neutral" }
  if (
    observation.reachability === "connected" &&
    observation.inventory === "missing"
  )
    return {
      label: "Missing",
      detail: "Resource is missing from its Relay",
      tone: "danger",
    }
  return instanceStatusPresentation({
    ...observation,
    kind: observation.kind,
    inventoryStatus: observation.inventory,
    observedState: observation.runtime ?? undefined,
    relayStatus: observation.reachability,
    relayUpdating: observation.updating,
  })
}
