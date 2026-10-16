import * as React from "react"
import { useQuery } from "@tanstack/react-query"
import { LoaderCircle } from "lucide-react"

import {
  databaseRelayAvailable,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import { InstanceInfoRail, InfoContainerCard } from "@/components/resource-info-rail"
import { formatBytes } from "@/lib/format-bytes"
import { managedDatabaseContainerQueryOptions } from "@/lib/query-options"

// What the database is at a glance, like a game server's. Its name and
// status are in the header.
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
    <InstanceInfoRail
      relayName={database.relayName}
      resource={resource}
      container={<DatabaseContainerCard database={database} />}
    />
  )
}

// The Relay reports the container's name, data folder, and volume size on
// request, and only while it's reachable. Databases have no limits.
function DatabaseContainerCard({ database }: { database: ManagedDatabase }) {
  const available = databaseRelayAvailable(database)
  const { data, isPending } = useQuery({
    ...managedDatabaseContainerQueryOptions(database.relayId, database.id),
    enabled: available,
  })
  const pending = available && isPending
  return (
    <InfoContainerCard
      containerId={database.containerId}
      dataDirectory={data?.dataDirectory ?? null}
      disk={
        data?.volumeBytes != null ? (
          <span className="tabular-nums" title="No disk limit">
            {formatBytes(data.volumeBytes)} used
          </span>
        ) : pending ? (
          <LoaderCircle
            aria-label="Loading"
            className="size-3.5 animate-spin text-muted-foreground"
          />
        ) : (
          <span className="text-muted-foreground">—</span>
        )
      }
      memory="No limit"
      name={data?.containerName ?? null}
      pending={pending}
    />
  )
}
