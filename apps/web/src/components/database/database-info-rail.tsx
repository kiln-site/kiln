import * as React from "react"
import { Container } from "lucide-react"

import type { ManagedDatabase } from "@/components/database/database-presentation"
import {
  InfoCopyValue,
  InfoFact,
  InfoRailCard,
  InfoRailGroup,
} from "@/components/info-page"
import {
  InfoRailBackupsLink,
  InfoRailRelayLink,
  InfoRailUsersLink,
} from "@/components/resource-info-rail"

// What the database is at a glance: links to the Relay it runs on, who can
// reach it, and its backups, then its container. Its name and status are in
// the header.
export function DatabaseInfoRail({ database }: { database: ManagedDatabase }) {
  const resource = React.useMemo(
    () => ({
      id: database.id,
      kind: "database" as const,
      relayId: database.relayId,
    }),
    [database.id, database.relayId]
  )
  return (
    <>
      <InfoRailGroup>
        <InfoRailRelayLink name={database.relayName} relayId={database.relayId} />
        <InfoRailUsersLink resource={resource} />
        <InfoRailBackupsLink resource={resource} />
      </InfoRailGroup>
      <DatabaseContainerCard database={database} />
    </>
  )
}

// The container the Relay runs the database in, as it reports it.
function DatabaseContainerCard({ database }: { database: ManagedDatabase }) {
  return (
    <InfoRailCard icon={<Container />} title="Container">
      <InfoFact label="ID">
        {database.containerId ? (
          <InfoCopyValue label="container ID" value={database.containerId} />
        ) : (
          <span className="text-muted-foreground">Not created</span>
        )}
      </InfoFact>
      <InfoFact label="Image">
        <InfoCopyValue label="image" value={database.image} />
      </InfoFact>
      <InfoFact label="Status">
        <span className="truncate" title={database.status}>
          {database.status}
        </span>
      </InfoFact>
    </InfoRailCard>
  )
}
