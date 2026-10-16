import { BadgeCheck } from "lucide-react"

import { InfoFact, InfoRailGroup } from "@/components/info-page"
import { LocalDateTime } from "@/components/local-date-time"
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
      <InfoRailGroup title="Ownership">
        <dl>
          <InfoFact label="Owner">
            <RelayOwner relay={relay} />
          </InfoFact>
          <InfoFact label="Paired">
            <LocalDateTime dateOnly timestamp={relay.createdAt} />
          </InfoFact>
        </dl>
      </InfoRailGroup>
      <RelayNodeCard facts={node} relay={relay} />
    </>
  )
}

// A Relay with no recorded owner, like one set up with Kiln itself, belongs
// to this Kiln.
function RelayOwner({ relay }: { relay: RelayDirectoryEntry }) {
  const owner = relay.ownerName ?? relay.ownerEmail
  if (owner) return <span className="truncate">{owner}</span>
  return (
    <span
      className="flex items-center gap-1"
      title="Belongs to this Kiln, not to one person"
    >
      Kiln
      <BadgeCheck aria-label="Verified" className="size-3.5 text-primary" />
    </span>
  )
}
