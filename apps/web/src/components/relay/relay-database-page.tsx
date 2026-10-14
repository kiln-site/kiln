import * as React from "react"
import {
  databaseOverviewSchema,
  databaseQueryResultSchema,
  databaseRowsSchema,
  type DatabaseReadRequest,
} from "@workspace/contracts"

import {
  DATABASE_QUERY_MAX_ROWS,
  type DatabaseSource,
} from "@/components/database-viewer/database-source"
import { FileToolbarIdentity } from "@/components/files/file-viewer-toolbar"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import { readRelayStateDatabase } from "@/server/relay-database"

const DatabaseViewer = React.lazy(async () => {
  const module = await import("@/components/database-viewer/database-viewer")
  return { default: module.DatabaseViewer }
})

const identity = () => (
  <FileToolbarIdentity path="network/relay.sqlite" readOnly />
)

export function RelayDatabasePage() {
  const { relay } = useRelayWorkspace()
  const source = React.useMemo<DatabaseSource>(() => {
    const read = (request: DatabaseReadRequest) =>
      readRelayStateDatabase({ data: { relayId: relay.id, request } })
    return {
      canQuery: true,
      canWrite: false,
      queryKey: ["relay-state-database", relay.id],
      overview: async () =>
        databaseOverviewSchema.parse(await read({ action: "overview" })),
      rows: async (input) =>
        databaseRowsSchema.parse(await read({ action: "rows", ...input })),
      query: async (sql, write) => {
        if (write) throw new Error("The Relay database is read-only")
        return databaseQueryResultSchema.parse(
          await read({ action: "query", sql, maxRows: DATABASE_QUERY_MAX_ROWS })
        )
      },
      mutate: () =>
        Promise.reject(new Error("The Relay database is read-only")),
    }
  }, [relay.id])
  return (
    <React.Suspense fallback={<div className="min-h-0 flex-1 bg-card" />}>
      <DatabaseViewer key={relay.id} identity={identity} source={source} />
    </React.Suspense>
  )
}
