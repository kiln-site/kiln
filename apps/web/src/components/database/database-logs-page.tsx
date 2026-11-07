import { ResourceLogsSession } from "@/components/console/resource-logs"
import { databaseRelayAvailable } from "@/components/database/database-presentation"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"

// The database container's output, followed live.
export function DatabaseLogsPage() {
  const { database } = useDatabaseWorkspace()
  return (
    <ResourceLogsSession
      key={`${database.relayId}:${database.id}`}
      id={database.id}
      kind="database"
      logName={database.name}
      relayAvailable={databaseRelayAvailable(database)}
      relayId={database.relayId}
    />
  )
}
