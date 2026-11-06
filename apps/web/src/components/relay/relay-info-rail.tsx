import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { InfoRailGroup } from "@/components/info-page"
import { OwnerCard } from "@/components/owner-card"
import {
  RelayNodeCard,
  useRelayNodeFacts,
} from "@/components/relay/relay-node-card"
import { RelayWorkloads } from "@/components/relay/relay-workloads"
import { InfoRailSecurityLink } from "@/components/resource-security-link"
import { ResourceNotificationsCard } from "@/components/resource-notifications-card"
import { canAccessRelayPermission } from "@/lib/navigation-destinations"
import { resourceNotificationKinds } from "@/lib/notification-preferences"
import type { NotificationKind } from "@/lib/notifications"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"
import type { RelayDirectoryEntry } from "@/lib/relay-route"

// What the Relay is at a glance: what runs on it, who owns it, and the node
// under it. Its name and status are in the header.
export function RelayInfoRail({
  relay,
  routeId,
}: {
  relay: RelayDirectoryEntry
  routeId: string
}) {
  const node = useRelayNodeFacts(relay.id)
  return (
    <>
      <RelayWorkloads relayId={relay.id} routeId={routeId} />
      <InfoRailGroup card>
        <InfoRailSecurityLink
          relayId={relay.id}
          resourceId={relay.id}
          resourceType="relay"
        />
      </InfoRailGroup>
      <RelayOwnerCard
        createdBy={relay.createdBy}
        ownerEmail={relay.ownerEmail}
        ownerName={relay.ownerName}
      />
      <RelayNodeCard facts={node} relay={relay} />
      <RelayNotifications relay={relay} />
    </>
  )
}

// Everything about a Relay goes to those who can update it.
const RelayNotifications = React.memo(function RelayNotifications({
  relay,
}: {
  relay: RelayDirectoryEntry
}) {
  const { data: capabilities } = useQuery(accessCapabilitiesQueryOptions())
  const { id, name } = relay
  const resource = React.useMemo(
    () => ({ id, name, relayId: id, type: "relay" as const }),
    [id, name]
  )
  const canUpdate =
    capabilities !== undefined &&
    canAccessRelayPermission(capabilities, id, "relay.update")
  return (
    <ResourceNotificationsCard
      kinds={canUpdate ? resourceNotificationKinds.relay : noKinds}
      resource={resource}
    />
  )
})

const noKinds: ReadonlyArray<NotificationKind> = []

// Who owns the Relay; its email only reaches platform admins.
const RelayOwnerCard = React.memo(function RelayOwnerCard({
  createdBy,
  ownerEmail,
  ownerName,
}: Pick<RelayDirectoryEntry, "createdBy" | "ownerEmail" | "ownerName">) {
  return <OwnerCard email={ownerEmail} name={ownerName} userId={createdBy} />
})
