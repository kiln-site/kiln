import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { RelayKindIcon } from "@/components/instance-kind-icon"
import { usePageMilestone } from "@/lib/page-timing"
import { RelayPowerControls } from "@/components/relay/relay-power-controls"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { RelayResourceMeters } from "@/components/relay/relay-resource-meters"
import {
  RelayWorkspaceContext,
  type RelayWorkspaceRelay,
} from "@/components/relay/relay-workspace-context"
import {
  ResourceWorkspaceBoundary,
  WorkspaceRouteTitle,
  useResourceWorkspaceQuery,
  useWorkspaceRouteParam,
  type ResourceWorkspaceQuery,
} from "@/components/resource-workspace"
import { WorkspaceFrame } from "@/components/workspace-frame"
import {
  WorkspaceCopyValueButton,
  WorkspaceHeader,
  WorkspaceIdCopyButton,
  WorkspaceIdentity,
  WorkspaceMetaSeparator,
} from "@/components/workspace-header"
import {
  canAccessRelayPermission,
  relayDestinations,
} from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaysQueryOptions,
} from "@/lib/query-options"
import {
  relayAddress,
  relayRouteIdentifier,
  resolveRelayRoute,
  type RelayDirectoryEntry,
} from "@/lib/relay-route"

export const RelayWorkspaceShell = React.memo(function RelayWorkspaceShell({
  children,
}: {
  children: React.ReactNode
}) {
  const routeId = useWorkspaceRouteParam("relayId")
  const workspace = useRelayWorkspaceQuery(routeId)

  return (
    <WorkspaceFrame header={<RelayWorkspaceHeader workspace={workspace} />}>
      <div data-slot="relay-workspace-surface" className="contents">
        <ResourceWorkspaceBoundary
          context={RelayWorkspaceContext}
          icon={<RelayKindIcon />}
          list={{ label: "All Relays", to: "/infra/relays" }}
          noun={{ one: "Relay", other: "Relays" }}
          workspace={workspace}
        >
          {children}
        </ResourceWorkspaceBoundary>
      </div>
    </WorkspaceFrame>
  )
})

function useRelayWorkspaceQuery(
  routeId: string | undefined
): ResourceWorkspaceQuery<RelayWorkspaceRelay> {
  const select = React.useMemo(
    () => (relays: Array<RelayDirectoryEntry>) => {
      const resolution = resolveRelayRoute(relays, routeId)
      return resolution.status === "found"
        ? {
            relay: resolution.resource,
            routeId: relayRouteIdentifier(relays, resolution.resource),
          }
        : null
    },
    [routeId]
  )
  return useResourceWorkspaceQuery(
    useQuery({ ...relaysQueryOptions(), select })
  )
}

const RelayWorkspaceHeader = React.memo(function RelayWorkspaceHeader({
  workspace,
}: {
  workspace: ResourceWorkspaceQuery<RelayWorkspaceRelay>
}) {
  if (workspace.status !== "found") return <WorkspaceHeader identity={null} />
  const { relay } = workspace.value

  return (
    <WorkspaceHeader
      identity={
        <WorkspaceIdentity
          name={relay.name}
          title={
            <WorkspaceRouteTitle
              destinations={relayDestinations}
              fallback="Info"
              notFoundRouteId="/_app/relay/$relayId/$"
            />
          }
        >
          <RelayStatusLabel relay={relay} />
          <span className="hidden shrink-0 items-center gap-1.5 @[40rem]:inline-flex">
            <WorkspaceIdCopyButton
              id={relay.id}
              label="Relay ID"
              shortId={relay.id.slice(0, 8)}
            />
            <WorkspaceMetaSeparator />
          </span>
          <WorkspaceCopyValueButton
            label="Relay address"
            value={relayAddress(relay)}
          />
        </WorkspaceIdentity>
      }
      center={<RelayResourceMeters relay={relay} />}
      actions={<RelayHeaderActions relay={relay} />}
    />
  )
})

// Only when the Relay isn't simply online: its meters and actions can't say
// why they're idle.
function RelayStatusLabel({ relay }: { relay: RelayDirectoryEntry }) {
  const { presentation, relayStatus, updating } = useRelayLiveStatus(relay)
  usePageMilestone("status", relayStatus !== "checking")
  if (!updating && (relayStatus === "connected" || relayStatus === "checking"))
    return null
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <span>{presentation.label}</span>
      <WorkspaceMetaSeparator />
    </span>
  )
}

function RelayHeaderActions({ relay }: { relay: RelayDirectoryEntry }) {
  const { data: permissions } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) => ({
      pause: canAccessRelayPermission(capabilities, relay.id, "relay.pause"),
      restartHost: canAccessRelayPermission(
        capabilities,
        relay.id,
        "relay.terminal"
      ),
      restartRelay: canAccessRelayPermission(
        capabilities,
        relay.id,
        "relay.update"
      ),
    }),
  })
  if (!permissions) return null
  return <RelayPowerControls permissions={permissions} relay={relay} />
}
