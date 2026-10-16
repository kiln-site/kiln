import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Activity, Container } from "lucide-react"

import {
  InfoCopyValue,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
  InfoRailLink,
} from "@/components/info-page"
import {
  InfoRailBackupsLink,
  InfoRailRelayLink,
  InfoRailUsersLink,
} from "@/components/resource-info-rail"
import { formatBytes } from "@/lib/format-bytes"
import { canAccessActivity } from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import type {
  InstanceSettingsInstance,
  RelayNodeSummary,
} from "@/lib/relay-selectors"

// What the game server is at a glance: links to the Relay it runs on, who
// can reach it, its activity, and its backups, then its container. Its name,
// status, and usage are in the header.
export function ServerInfoRail({
  instance,
  node,
}: {
  instance: InstanceSettingsInstance
  node: RelayNodeSummary
}) {
  const resource = React.useMemo(
    () => ({
      id: instance.id,
      kind: "instance" as const,
      relayId: instance.relayId,
    }),
    [instance.id, instance.relayId]
  )
  return (
    <>
      <InfoRailGroup>
        <InfoRailRelayLink name={node.name} relayId={instance.relayId} />
        <InfoRailUsersLink resource={resource} />
        <ServerActivityLink instance={instance} />
        <InfoRailBackupsLink resource={resource} />
      </InfoRailGroup>
      <ServerContainerCard instance={instance} />
    </>
  )
}

// Activity filters by game server, so only game servers link to it.
function ServerActivityLink({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  const { data: canViewActivity } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select: canAccessActivity,
  })
  if (!canViewActivity) return null
  return (
    <InfoRailLink
      to="/activity"
      search={{ relay: instance.relayId, server: instance.id }}
      leading={<Activity />}
    >
      Activity
    </InfoRailLink>
  )
}

// Where the server lives on the Relay, and the limits it runs under.
function ServerContainerCard({
  instance,
}: {
  instance: InstanceSettingsInstance
}) {
  return (
    <InfoRailCard icon={<Container />} title="Container">
      <InfoFact label="Name">
        <InfoCopyValue label="container name" value={instance.service} />
      </InfoFact>
      <InfoFact label="ID">
        {instance.containerId ? (
          <InfoCopyValue label="container ID" value={instance.containerId} />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      {/* The server's folder on the Relay's host; older Relays don't say. */}
      {instance.hostDirectory ? (
        <InfoFact label="Data">
          <InfoCopyValue
            display="Copy path"
            label="data path"
            mono={false}
            value={instance.hostDirectory}
          />
        </InfoFact>
      ) : null}
      {/* Game servers have no CPU limit yet. */}
      <InfoFact label="CPU">
        <span className="text-muted-foreground" title="No CPU limit">
          —
        </span>
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
