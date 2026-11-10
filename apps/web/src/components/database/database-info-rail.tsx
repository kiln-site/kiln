import * as React from "react"

import type { ManagedDatabase } from "@/components/database/database-presentation"
import { InstanceInfoRail } from "@/components/resource-info-rail"

// What the database is at a glance, like a game server's. Its name and
// status are in the header.
export function DatabaseInfoRail({ database }: { database: ManagedDatabase }) {
  const resource = React.useMemo(
    () => ({
      id: database.id,
      kind: "database" as const,
      name: database.name,
      relayId: database.relayId,
    }),
    [database.id, database.name, database.relayId]
  )
  return (
    <InstanceInfoRail relayName={database.relayName} resource={resource} />
  )
}
