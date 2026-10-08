import * as React from "react"
import { Database, Play } from "lucide-react"

import {
  DATABASE_QUERY_MAX_ROWS,
  type DatabaseSource,
} from "@/components/database-viewer/database-source"
import { useDatabaseWorkspace } from "@/components/database/database-workspace-context"
import {
  getManagedDatabaseOverview,
  getManagedDatabaseRows,
  mutateManagedDatabase,
  runManagedDatabaseQuery,
} from "@/server/databases"

const DatabaseViewer = React.lazy(async () => {
  const module = await import("@/components/database-viewer/database-viewer")
  return { default: module.DatabaseViewer }
})

export function DatabaseViewerPage() {
  const { database } = useDatabaseWorkspace()
  const canWrite = database.permissions.includes("database.data.write")
  const source = React.useMemo(
    () =>
      managedDatabaseSource({
        canWrite,
        databaseId: database.id,
        relayId: database.relayId,
      }),
    [canWrite, database.id, database.relayId]
  )
  const identity = React.useCallback(
    ({ readOnly }: { readOnly: boolean | null }) => (
      <div className="flex min-w-0 flex-1 items-center gap-2.5 md:gap-3">
        <Database className="size-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="mb-1 flex min-w-0 items-center gap-2.5">
            <p className="min-w-0 truncate text-sm font-semibold">Tables</p>
            {readOnly ? (
              <span className="type-technical-label hidden shrink-0 border border-primary/20 bg-primary/8 px-2 py-0.5 text-primary sm:inline-flex">
                READ ONLY
              </span>
            ) : null}
          </div>
          <p className="type-code truncate text-muted-foreground">
            {database.databaseName}
          </p>
        </div>
      </div>
    ),
    [database.databaseName]
  )

  if (database.observedState !== "running") {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
            <Play className="size-5" />
          </div>
          <p className="text-sm font-semibold">
            {database.name} is not running
          </p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Start the database to browse its tables.
          </p>
        </div>
      </div>
    )
  }

  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <DatabaseViewer identity={identity} source={source} />
    </React.Suspense>
  )
}

function managedDatabaseSource({
  canWrite,
  databaseId,
  relayId,
}: {
  canWrite: boolean
  databaseId: string
  relayId: string
}): DatabaseSource {
  const target = { databaseId, relayId }
  return {
    // The Relay runs SQL only for people who may write; see
    // runManagedDatabaseQuery.
    canQuery: canWrite,
    canWrite,
    queryKey: ["database-viewer", relayId, databaseId],
    overview: () => getManagedDatabaseOverview({ data: target }),
    rows: (input) =>
      getManagedDatabaseRows({
        data: { ...target, request: { action: "rows", ...input } },
      }),
    query: (sql, write) =>
      runManagedDatabaseQuery({
        data: {
          ...target,
          readOnly: !write,
          request: { action: "query", maxRows: DATABASE_QUERY_MAX_ROWS, sql },
        },
      }),
    mutate: (table, changes) =>
      mutateManagedDatabase({
        data: { ...target, request: { action: "mutate", changes, table } },
      }),
  }
}
