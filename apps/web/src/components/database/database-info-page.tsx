import * as React from "react"
import { useNavigate } from "@tanstack/react-router"

import { DeleteDatabaseDialog } from "@/components/database/database-dialogs"
import { DatabaseInfoRail } from "@/components/database/database-info-rail"
import {
  databaseRelayAvailable,
  type ManagedDatabase,
} from "@/components/database/database-presentation"
import {
  DatabaseConnectionSettings,
  DatabaseCredentialsSection,
  DatabaseDataSection,
  DatabaseGeneralSettings,
} from "@/components/database/database-settings"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import { InfoDangerZone, InfoPage } from "@/components/info-page"

// The database's details, each section with the actions that change it, and
// a rail summing up where it runs and who can reach it.
export function DatabaseInfoPage() {
  const { database, routeId } = useDatabaseWorkspace()
  const can = (permission: ManagedDatabase["permissions"][number]) =>
    database.permissions.includes(permission)
  const available = databaseRelayAvailable(database)
  const canExport = can("database.dump.export")
  const canImport = can("database.dump.import")

  return (
    <InfoPage rail={<DatabaseInfoRail database={database} />}>
      <DatabaseGeneralSettings database={database} />
      <DatabaseConnectionSettings
        canViewNetwork={can("database.network.read")}
        database={database}
        routeId={routeId}
      />
      {can("database.credentials.read") && database.hasCredentials ? (
        <DatabaseCredentialsSection
          key={`${database.relayId}:${database.id}`}
          canRotate={available && can("database.credentials.rotate")}
          database={database}
        />
      ) : null}
      {database.supportsImportExport &&
      database.hasCredentials &&
      (canExport || canImport) ? (
        <DatabaseDataSection
          available={available}
          canExport={canExport}
          canImport={canImport}
          database={database}
        />
      ) : null}
      {can("database.delete") ? (
        <DatabaseDangerZone database={database} />
      ) : null}
    </InfoPage>
  )
}

function DatabaseDangerZone({ database }: { database: ManagedDatabase }) {
  const navigate = useNavigate()
  const leave = React.useCallback(() => {
    void navigate({ to: "/infra/databases", replace: true })
  }, [navigate])
  return (
    <InfoDangerZone
      title="Delete this database"
      action="Delete database"
      dialog={(onOpenChange) => (
        <DeleteDatabaseDialog
          database={database}
          open
          onDeleted={leave}
          onOpenChange={onOpenChange}
        />
      )}
    />
  )
}
