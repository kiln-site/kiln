import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { useHydrated } from "@tanstack/react-router"

import type {
  InstanceInventory,
  InstanceObservation,
  RelayProxyDiagnostics,
} from "@workspace/contracts"

import {
  relayStatusPresentation,
  type InstanceStatusPresentation,
  type RelayIdentityStatus,
} from "@/components/instance-name-presentation"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
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
// while the poll has no entry for it. Whether it's paused comes from what the
// Relay reports (`observed`): a Relay paused here is `pausing` until it has
// the pause, and one another Hearth paused is paused too.
export function relayLiveState(
  enabled: boolean,
  state: { status: string; updating?: boolean } | null | undefined,
  missing: "checking" | "unknown",
  observed?: InstanceObservation["reachability"]
): { relayStatus: RelayIdentityStatus; updating: boolean } {
  if (observed === "paused") return { relayStatus: "paused", updating: false }
  if (!enabled) {
    return {
      relayStatus: observed === "pausing" ? "pausing" : "checking",
      updating: false,
    }
  }
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
  const observed = useRelayPauseState(relay.id)
  // The check streams into a page while Hearth renders it, so it can arrive
  // before the browser hydrates. Until then it reads as Hearth rendered it,
  // still checking, so the two renders match.
  const hydrated = useHydrated()
  const known = hydrated ? state : undefined
  const checking = isPending || !hydrated
  // Structural sharing keeps `state` stable while the Relay's state is.
  return React.useMemo(() => {
    const { relayStatus, updating } = relayLiveState(
      relay.enabled,
      known,
      checking ? "checking" : "unknown",
      observed
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
  }, [checking, known, observed, relay.enabled, relay.lastError])
}

/**
 * Whether the Relay reports itself paused (`paused`), or is paused here but
 * hasn't taken it yet (`pausing`). The connection poll leaves out paused
 * Relays and doesn't say whether a Relay is paused; its inventory does.
 */
export function useRelayPauseState(
  relayId: string
): "paused" | "pausing" | undefined {
  const { data } = useQuery({
    ...instanceInventoryQueryOptions(
      { id: relayId, kind: "relay", relayId },
      "status"
    ),
    notifyOnChangeProps: ["data"],
    select: selectPauseState,
  })
  return data
}

// Only the pause, so other inventory changes don't re-render.
function selectPauseState(
  inventory: InstanceInventory
): "paused" | "pausing" | undefined {
  const { reachability } = inventory.observation
  return reachability === "paused" || reachability === "pausing"
    ? reachability
    : undefined
}

export const proxyModeLabels = {
  coolify: "Coolify Traefik",
  hearth: "Hearth proxy",
  none: "None / existing Traefik",
  traefik: "Bundled Traefik",
} as const

export function proxyStatusPresentation(
  diagnostics: Pick<
    RelayProxyDiagnostics,
    "containerRunning" | "mode" | "ports" | "status"
  >
): InstanceStatusPresentation {
  switch (diagnostics.status) {
    case "ready":
      return { label: "Ready", tone: "success" }
    case "starting":
      return { label: "Starting", pulse: true, tone: "info" }
    case "blocked":
      return {
        detail: proxyBlockedReason(diagnostics),
        label: "Blocked",
        tone: "danger",
      }
    case "hearth":
      return { label: "Through Hearth", tone: "info" }
    case "disabled":
      return { label: "Disabled", tone: "neutral" }
  }
}

// Why a proxy can't serve, from what the Relay found rather than its prose.
function proxyBlockedReason(
  diagnostics: Pick<
    RelayProxyDiagnostics,
    "containerRunning" | "mode" | "ports"
  >
): string | undefined {
  if (diagnostics.mode === "coolify") {
    return diagnostics.containerRunning
      ? "Coolify’s Traefik isn’t connected to Kiln yet. The Relay keeps retrying."
      : "Coolify’s proxy isn’t running on this node."
  }
  const taken = diagnostics.ports.filter((port) => !port.available)
  if (taken.length === 0) return undefined
  return taken
    .map(
      (port) =>
        `Port ${port.port} is in use by ${port.owner ?? "another program"}.`
    )
    .join(" ")
}

export interface ProxyModeCoverage {
  items: ReadonlyArray<{ covered: boolean; label: string }>
  note: string | null
}

// What traffic each proxy mode carries, as a checklist beside it.
export function proxyModeCoverage(
  diagnostics: Pick<RelayProxyDiagnostics, "mode" | "warnings">
): ProxyModeCoverage {
  const relay = diagnostics.mode !== "none"
  const web = diagnostics.mode === "traefik" || diagnostics.mode === "coolify"
  const items = [
    { covered: relay, label: "Console traffic" },
    { covered: relay, label: "File reads and writes" },
    { covered: web, label: "App domains" },
    { covered: web, label: "Game server web routes" },
  ]
  switch (diagnostics.mode) {
    case "none": {
      // The Relay names the Docker network only in its note about this mode.
      const network = diagnostics.warnings
        .map((warning) => /Attach it to (\S+) before/u.exec(warning)?.[1])
        .find(Boolean)
      return {
        items,
        note: `Console and files reach the Relay directly. For domains, connect your own proxy to ${
          network
            ? `the ${network} Docker network`
            : "this Relay’s edge network"
        }.`,
      }
    }
    case "hearth":
      return {
        items,
        note: "For domains, switch to Bundled or Coolify Traefik.",
      }
    case "traefik":
      return {
        items,
        note: "Certificates come from Let’s Encrypt. Kiln can’t tell from here whether the internet reaches Traefik.",
      }
    case "coolify":
      return { items, note: null }
  }
}
