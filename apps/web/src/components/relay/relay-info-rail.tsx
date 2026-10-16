import * as React from "react"
import { useQuery } from "@tanstack/react-query"

import { OwnerCard } from "@/components/owner-card"
import {
  RelayNodeCard,
  useRelayNodeFacts,
} from "@/components/relay/relay-node-card"
import { RelayWorkloads } from "@/components/relay/relay-workloads"
import {
  isMinecraftUsername,
  minecraftUsernameKey,
  relayOwnerNamesKey,
  selectOwnerProfileIds,
} from "@/lib/minecraft-profile"
import {
  relayOwnerMinecraftProfilesQueryOptions,
  relaysQueryOptions,
} from "@/lib/query-options"
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
        ownerEmail={relay.ownerEmail}
        ownerName={relay.ownerName}
      />
      <RelayNodeCard facts={node} relay={relay} />
    </>
  )
}

// Who owns the Relay; its email only reaches platform admins. The owner's
// head comes from the avatars the Relays list caches.
const RelayOwnerCard = React.memo(function RelayOwnerCard({
  ownerEmail,
  ownerName,
}: Pick<RelayDirectoryEntry, "ownerEmail" | "ownerName">) {
  const profileId = useRelayOwnerProfileId(ownerName)
  return <OwnerCard email={ownerEmail} name={ownerName} profileId={profileId} />
})

function useRelayOwnerProfileId(name: string | null): string | null {
  const { data: ownerNames = "" } = useQuery({
    ...relaysQueryOptions(),
    select: relayOwnerNamesKey,
  })
  const select = React.useCallback(
    (profiles: Array<{ displayName: string; profileId: string }>) =>
      name
        ? (selectOwnerProfileIds(profiles).get(minecraftUsernameKey(name)) ??
          null)
        : null,
    [name]
  )
  const { data: profileId } = useQuery({
    ...relayOwnerMinecraftProfilesQueryOptions(ownerNames),
    enabled:
      ownerNames.length > 0 && name !== null && isMinecraftUsername(name),
    select,
  })
  return profileId ?? null
}
