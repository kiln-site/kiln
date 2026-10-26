import * as React from "react"

import { OwnerCard } from "@/components/owner-card"
import {
  RelayNodeCard,
  useRelayNodeFacts,
} from "@/components/relay/relay-node-card"
import { RelayWorkloads } from "@/components/relay/relay-workloads"
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
      <RelayOwnerCard
        createdBy={relay.createdBy}
        ownerEmail={relay.ownerEmail}
        ownerName={relay.ownerName}
      />
      <RelayNodeCard facts={node} relay={relay} />
    </>
  )
}

// Who owns the Relay; its email only reaches platform admins.
const RelayOwnerCard = React.memo(function RelayOwnerCard({
  createdBy,
  ownerEmail,
  ownerName,
}: Pick<RelayDirectoryEntry, "createdBy" | "ownerEmail" | "ownerName">) {
  return <OwnerCard email={ownerEmail} name={ownerName} userId={createdBy} />
})
