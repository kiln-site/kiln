import * as React from "react"
import { Table2 } from "lucide-react"

import {
  DATABASE_QUERY_MAX_ROWS,
  type DatabaseSource,
} from "@/components/database-viewer/database-source"
import { HearthMark } from "@/components/hearth-mark"
import { useKilnHost } from "@/components/kiln/kiln-presentation"
import {
  getKilnDatabaseOverview,
  getKilnDatabaseRows,
  mutateKilnDatabase,
  runKilnDatabaseQuery,
} from "@/server/kiln-database"

const DatabaseViewer = React.lazy(async () => {
  const module = await import("@/components/database-viewer/database-viewer")
  return { default: module.DatabaseViewer }
})

// Hearth's own database in the Viewer, through the Relay on its host.
// Platform administrators may change it, as they may change anything.
export function KilnViewerPage() {
  const host = useKilnHost()
  const relayId = host?.relayId ?? null
  const source = React.useMemo(
    () => (relayId ? kilnDatabaseSource(relayId) : null),
    [relayId]
  )
  if (!host || !source || !host.database) {
    return (
      <div className="grid min-h-0 flex-1 place-items-center bg-card px-6 text-center">
        <div className="max-w-sm">
          <div className="mx-auto mb-4 grid size-11 place-items-center rounded-xl border bg-muted/20 text-muted-foreground">
            <Table2 className="size-5" />
          </div>
          <p className="text-sm font-semibold">Update this Relay</p>
          <p className="mt-1.5 text-xs leading-relaxed text-muted-foreground">
            Update {host?.relayName ?? "the Relay on Kiln's host"} to browse
            Kiln&apos;s database.
          </p>
        </div>
      </div>
    )
  }
  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <DatabaseViewer identity={kilnViewerIdentity} source={source} />
    </React.Suspense>
  )
}

function kilnViewerIdentity() {
  return (
    <div className="flex min-w-0 flex-1 items-center gap-2.5 md:gap-3">
      <HearthMark className="size-5" />
      <div className="min-w-0 flex-1">
        <p className="mb-1 min-w-0 truncate text-sm font-semibold">Tables</p>
        <p className="type-code truncate text-muted-foreground">
          Kiln&apos;s database
        </p>
      </div>
    </div>
  )
}

function kilnDatabaseSource(relayId: string): DatabaseSource {
  return {
    canQuery: true,
    canWrite: true,
    queryKey: ["database-viewer", "kiln", relayId],
    overview: () => getKilnDatabaseOverview({ data: { relayId } }),
    rows: (input) =>
      getKilnDatabaseRows({
        data: { relayId, request: { action: "rows", ...input } },
      }),
    query: (sql, write) =>
      runKilnDatabaseQuery({
        data: {
          readOnly: !write,
          relayId,
          request: { action: "query", maxRows: DATABASE_QUERY_MAX_ROWS, sql },
        },
      }),
    mutate: (table, changes) =>
      mutateKilnDatabase({
        data: { relayId, request: { action: "mutate", changes, table } },
      }),
  }
}
