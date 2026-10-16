import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import type { RelayProxyDiagnostics } from "@workspace/contracts"

import {
  relayStatusPresentation,
  type InstanceStatusPresentation,
  type RelayIdentityStatus,
} from "@/components/instance-name-presentation"
import {
  relayConnectionQueryOptions,
  type RelayConnection,
} from "@/lib/query-options"

export interface RelayLiveStatus {
  connected: boolean
  presentation: InstanceStatusPresentation
  relayStatus: RelayIdentityStatus
  updating: boolean
}

// A Relay's status from its entry in the shared connection poll, or `missing`
// while the poll has no entry for it.
export function relayLiveState(
  enabled: boolean,
  state: { status: string; updating?: boolean } | null | undefined,
  missing: "checking" | "unknown"
): { relayStatus: RelayIdentityStatus; updating: boolean } {
  if (!enabled) return { relayStatus: "paused", updating: false }
  const status = state?.status
  return {
    relayStatus:
      status === "connected" || status === "unreachable" ? status : missing,
    updating: state?.updating === true,
  }
}

// Whether Hearth reaches the Relay now, from the shared connection poll.
export function useRelayLiveStatus(relay: {
  enabled: boolean
  id: string
  lastError: string | null
}): RelayLiveStatus {
  const queryClient = useQueryClient()
  const select = React.useCallback(
    (connection: RelayConnection) => {
      if (connection.status === "unconfigured") return null
      const state = connection.relays.find(({ id }) => id === relay.id)
      return state
        ? { status: state.status, updating: state.updating === true }
        : null
    },
    [relay.id]
  )
  const { data: state, isPending } = useQuery({
    ...relayConnectionQueryOptions(queryClient),
    notifyOnChangeProps: ["data", "isPending"],
    select,
  })
  // Structural sharing keeps `state` stable while the Relay's state is.
  return React.useMemo(() => {
    const { relayStatus, updating } = relayLiveState(
      relay.enabled,
      state,
      isPending ? "checking" : "unknown"
    )
    return {
      connected: relayStatus === "connected",
      presentation: relayStatusPresentation({
        enabled: relay.enabled,
        lastError: relay.lastError,
        relayStatus,
        updating,
      }),
      relayStatus,
      updating,
    }
  }, [isPending, relay.enabled, relay.lastError, state])
}

export const proxyModeLabels = {
  coolify: "Coolify Traefik",
  hearth: "Hearth proxy",
  none: "None / existing Traefik",
  traefik: "Bundled Traefik",
} as const

export function proxyStatusPresentation(
  diagnostics: Pick<RelayProxyDiagnostics, "status">
): InstanceStatusPresentation {
  switch (diagnostics.status) {
    case "ready":
      return { label: "Ready", tone: "success" }
    case "starting":
      return { label: "Starting", pulse: true, tone: "info" }
    case "blocked":
      return { label: "Blocked", tone: "danger" }
    case "hearth":
      return { label: "Through Hearth", tone: "info" }
    case "disabled":
      return { label: "Disabled", tone: "neutral" }
  }
}
