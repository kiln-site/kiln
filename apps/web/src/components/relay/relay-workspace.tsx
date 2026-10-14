import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { RadioTower } from "lucide-react"

import { RelayPauseButton } from "@/components/relay/relay-actions"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
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
          icon={<RadioTower />}
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
          <span className="hidden shrink-0 items-center gap-1.5 @[30rem]:inline-flex">
            <RelayStatusLabel relay={relay} />
            <WorkspaceMetaSeparator />
          </span>
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
      actions={<RelayHeaderActions relay={relay} />}
    />
  )
})

function RelayStatusLabel({ relay }: { relay: RelayDirectoryEntry }) {
  const { presentation } = useRelayLiveStatus(relay)
  return <span>{presentation.label}</span>
}

function RelayHeaderActions({ relay }: { relay: RelayDirectoryEntry }) {
  const { data: canPause = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: (capabilities) =>
      canAccessRelayPermission(capabilities, relay.id, "relay.pause"),
  })
  if (!canPause) return null
  return (
<RelayPauseButton relay={relay} />
  )
}
