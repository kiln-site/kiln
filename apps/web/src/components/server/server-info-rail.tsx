import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, Box, RadioTower, Users } from "lucide-react"

import {
  InfoCopyValue,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
} from "@/components/info-page"
import { useRelayLiveStatus } from "@/components/relay/relay-presentation"
import { StatusIndicator } from "@/components/status-indicator"
import { formatBytes } from "@/lib/format-bytes"
import { canAccessActivity } from "@/lib/navigation-destinations"
import {
  accessCapabilitiesQueryOptions,
  relaysQueryOptions,
} from "@/lib/query-options"
import { relayRouteIdentifier, type RelayDirectoryEntry } from "@/lib/relay-route"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"

// What the game server is at a glance: the Relay it runs on, who can reach
// it, and its container. Its name, status, and usage are in the header.
export function ServerInfoRail({
  instance,
  node,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
}) {
  return (
    <>
      <InfoRailGroup title="Runs on">
        <ServerRelayLink node={node} relayId={instance.relayId} />
      </InfoRailGroup>
      <ServerAccessLinks instance={instance} />
      <ServerContainerCard instance={instance} />
    </>
  )
}

// Links to the Relay for those who manage it; others see just its name.
function ServerRelayLink({
  node,
  relayId,
}: {
  node: RelayNodeSummary
  relayId: string
}) {
  const select = React.useCallback(
    (relays: Array<RelayDirectoryEntry>) => {
      const relay = relays.find((candidate) => candidate.id === relayId)
      return relay
        ? { relay, routeId: relayRouteIdentifier(relays, relay) }
        : null
    },
    [relayId]
  )
  const { data } = useQuery({ ...relaysQueryOptions(), select })
  if (!data) {
    return (
      <dl>
        <InfoFact label="Relay">
          <span className="truncate">{node.name}</span>
        </InfoFact>
      </dl>
    )
  }
  return <RelayLink relay={data.relay} routeId={data.routeId} />
}

function RelayLink({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const { presentation } = useRelayLiveStatus(relay)
  return (
    <InfoRailLink
      to="/relay/$relayId/info"
      params={{ relayId: routeId }}
      leading={<RadioTower />}
      detail={<StatusIndicator status={presentation} />}
    >
      {relay.name}
    </InfoRailLink>
  )
}

function ServerAccessLinks({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  const { data: access } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: selectAccessLinks,
  })
  if (!access?.canManageAccess && !access?.canViewActivity) return null
  return (
    <InfoRailGroup title="Access">
      {access.canManageAccess ? (
        <InfoRailLink
          to="/access"
          search={{
            relayId: instance.relayId,
            resourceId: instance.id,
            resourceType: "instance",
            tab: "users",
          }}
          leading={<Users />}
        >
          Users and permissions
        </InfoRailLink>
      ) : null}
      {access.canViewActivity ? (
        <InfoRailLink
          to="/activity"
          search={{ relay: instance.relayId, server: instance.id }}
          leading={<Activity />}
        >
          Activity
        </InfoRailLink>
      ) : null}
    </InfoRailGroup>
  )
}

function selectAccessLinks(
  capabilities: Parameters<typeof canAccessActivity>[0]
) {
  return {
    canManageAccess: capabilities.canManageAccess,
    canViewActivity: canAccessActivity(capabilities),
  }
}

// Where the server lives on the Relay, and the limits it runs under.
function ServerContainerCard({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  return (
    <InfoRailCard icon={<Box />} title="Container">
      <InfoFact label="Container">
        {instance.containerId ? (
          <InfoCopyValue label="container ID" value={instance.containerId} />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      <InfoFact label="Service">
        <span className="truncate font-mono text-xs" title={instance.service}>
          {instance.service}
        </span>
      </InfoFact>
      <InfoFact label="Data">
        <InfoCopyValue label="data directory" value={instance.directory} />
      </InfoFact>
      <InfoFact label="Memory">
        {instance.limits.memoryBytes > 0
          ? `${formatBytes(instance.limits.memoryBytes)} limit`
          : "No limit"}
      </InfoFact>
      <InfoFact label="Disk">
        {`${formatBytes(instance.limits.diskBytes)} limit`}
      </InfoFact>
    </InfoRailCard>
  )
}
