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
  DatabaseContainerSection,
  DatabaseProfile,
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
import { ResourceDeletionAlert } from "@/components/resource-deletion-alert"
import { ResourceMigrationSection } from "@/components/resource-migration-section"

// The database's details, in the order every kind's Info page has: what it
// is and the engine it runs, its container with its usage and limits, then
// what only a database has, each section with the actions that change it,
// and a rail summing up where it runs and who can reach it.
export function DatabaseInfoPage() {
  const { database } = useDatabaseWorkspace()
  const can = (permission: ManagedDatabase["permissions"][number]) =>
    database.permissions.includes(permission)
  const available = databaseRelayAvailable(database)
  const canExport = can("database.dump.export")
  const canImport = can("database.dump.import")
  const canRestore = useDatabaseBackupPermissions(database, backupRestore)
  // Its Relay copies it as it backs it up, so copying it takes those.
  const canCopy =
    useDatabaseBackupPermissions(database, backupCopy) && can("database.read")
  // As the Viewer tab is offered.
  const canView =
    databaseEngineSupportsBrowsing(database.engine) && can("database.data.read")

  return (
    <InfoPage rail={<DatabaseInfoRail database={database} />}>
      <ResourceDeletionAlert
        canDelete={can("database.delete")}
        name={database.name}
        kind="database"
        relayId={database.relayId}
        resourceId={database.id}
      />
      <DatabaseProfile
        canRename={can("database.delete") && database.hasCredentials}
        database={database}
      />
      <DatabaseContainerSection
        available={available}
        canReadLogs={can("instance.logs.read")}
        database={database}
        editable={can("instance.limits.write")}
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
        />
      ) : null}
      <DatabaseConnectionSettings
        canViewNetwork={can("database.network.read")}
        database={database}
      />
      {canCopy && !database.provisioning ? (
        <ResourceMigrationSection
          relayConnected={available}
          resource={{
            id: database.id,
            kind: "database",
            name: database.name,
            relayId: database.relayId,
          }}
        />
      ) : null}
      {can("database.delete") ? (
        <DatabaseDangerZone
          canWipe={database.hasCredentials}
          database={database}
        />
      ) : null}
    </InfoPage>
  )
}

const backupRestore = ["backup.restore"] as const
const backupCopy = ["backup.create", "backup.download"] as const

// Backup permissions come from access grants, not the database's own list.
function useDatabaseBackupPermissions(
  database: ManagedDatabase,
  permissions: ReadonlyArray<
    "backup.create" | "backup.download" | "backup.restore"
  >
): boolean {
  const select = React.useCallback(
    (capabilities: NavigationAccessCapabilities) =>
      permissions.every((permission) =>
        canAccessDatabasePermission(capabilities, database, permission)
      ),
    [database, permissions]
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
