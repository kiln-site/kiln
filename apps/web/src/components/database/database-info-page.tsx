import * as React from "react"
import { databaseEngineSupportsBrowsing } from "@workspace/contracts"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"

import { Eraser } from "lucide-react"

import {
  DeleteDatabaseDialog,
  WipeDatabaseDialog,
} from "@/components/database/database-dialogs"
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
  DatabaseLimitsSection,
} from "@/components/database/database-settings"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import {
  InfoDangerAction,
  InfoDangerZone,
  InfoPage,
} from "@/components/info-page"
import {
  canAccessDatabasePermission,
  type NavigationAccessCapabilities,
} from "@/lib/navigation-destinations"
import { accessCapabilitiesQueryOptions } from "@/lib/query-options"

// The database's details, each section with the actions that change it, and
// a rail summing up where it runs and who can reach it.
export function DatabaseInfoPage() {
  const { database, routeId } = useDatabaseWorkspace()
  const can = (permission: ManagedDatabase["permissions"][number]) =>
    database.permissions.includes(permission)
  const available = databaseRelayAvailable(database)
  const canExport = can("database.dump.export")
  const canImport = can("database.dump.import")
  const canRestore = useDatabaseBackupRestore(database)
  // As the Viewer tab is offered.
  const canView =
    databaseEngineSupportsBrowsing(database.engine) &&
    can("database.data.read")

  return (
    <InfoPage rail={<DatabaseInfoRail database={database} />}>
      <DatabaseGeneralSettings
        canRename={can("database.delete") && database.hasCredentials}
        database={database}
      />
      {can("database.credentials.read") && database.hasCredentials ? (
        <DatabaseCredentialsSection
          key={`${database.relayId}:${database.id}`}
          available={available}
          canRotate={can("database.credentials.rotate")}
          database={database}
        />
      ) : null}
      {database.supportsImportExport &&
      database.hasCredentials &&
      (canExport || canImport || canRestore || canView) ? (
        <DatabaseDataSection
          available={available}
          canExport={canExport}
          canImport={canImport}
          canRestore={canRestore}
          canView={canView}
          database={database}
          routeId={routeId}
        />
      ) : null}
      <DatabaseLimitsSection
        available={available}
        database={database}
        editable={can("database.limits.write")}
      />
      <DatabaseConnectionSettings
        canViewNetwork={can("database.network.read")}
        database={database}
        routeId={routeId}
      />
      {can("database.delete") ? (
        <DatabaseDangerZone
          canWipe={database.hasCredentials}
          database={database}
        />
      ) : null}
    </InfoPage>
  )
}

// Backup permissions come from access grants, not the database's own list.
function useDatabaseBackupRestore(database: ManagedDatabase): boolean {
  const select = React.useCallback(
    (capabilities: NavigationAccessCapabilities) =>
      canAccessDatabasePermission(capabilities, database, "backup.restore"),
    [database]
  )
  const { data = false } = useQuery({
    ...accessCapabilitiesQueryOptions(),
    select,
  })
  return data
}

function DatabaseDangerZone({
  canWipe,
  database,
}: {
  canWipe: boolean
  database: ManagedDatabase
}) {
  const navigate = useNavigate()
  const leave = React.useCallback(() => {
    void navigate({ to: "/infra/databases", replace: true })
  }, [navigate])
  const running =
    database.observedState === "running" ||
    database.observedState === "starting"
  return (
    <InfoDangerZone>
      {canWipe ? (
        <InfoDangerAction
          icon={<Eraser />}
          disabledReason={
            !databaseRelayAvailable(database)
              ? "Reconnect this database's Relay first"
              : running
                ? undefined
                : "Start the database before wiping it"
          }
          dialog={(onOpenChange) => (
            <WipeDatabaseDialog
              database={database}
              onOpenChange={onOpenChange}
            />
          )}
        >
          Wipe database
        </InfoDangerAction>
      ) : null}
      <InfoDangerAction
        dialog={(onOpenChange) => (
          <DeleteDatabaseDialog
            database={database}
            open
            onDeleted={leave}
            onOpenChange={onOpenChange}
          />
        )}
      >
        Delete database
      </InfoDangerAction>
    </InfoDangerZone>
  )
}
