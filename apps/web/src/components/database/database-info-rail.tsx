import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { Container, LoaderCircle } from "lucide-react"

import {
  databaseRelayAvailable,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
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
import { formatBytes } from "@/lib/format-bytes"
import { managedDatabaseUsageQueryOptions } from "@/lib/query-options"

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
      <InfoFact label="Volume">
        <VolumeSize database={database} />
      </InfoFact>
    </InfoRailCard>
  )
}

// How much the data volume holds. The Relay measures it on request, so it's
// read only while its Relay is reachable.
function VolumeSize({ database }: { database: ManagedDatabase }) {
  const available = databaseRelayAvailable(database)
  const { data, error, isPending } = useQuery({
    ...managedDatabaseUsageQueryOptions(database.relayId, database.id),
    enabled: available,
  })
  if (available && isPending) {
    return (
      <LoaderCircle
        aria-label="Measuring"
        className="size-3.5 animate-spin text-muted-foreground"
      />
    )
  }
  if (!data || data.volumeBytes === null) {
    return (
      <span
        className="text-muted-foreground"
        title={error?.message ?? "The Relay couldn't measure the volume"}
      >
        —
      </span>
    )
  }
  return <span className="tabular-nums">{formatBytes(data.volumeBytes)}</span>
}
