import * as React from "react"

import {
  DATABASE_QUERY_MAX_ROWS,
  type DatabaseSource,
} from "@/components/database-viewer/database-source"
import { FileToolbarIdentity } from "@/components/files/file-viewer-toolbar"
import { useRelayWorkspace } from "@/components/relay/relay-workspace-context"
import {
  getRelayStateDatabaseOverview,
  getRelayStateDatabaseRows,
  runRelayStateDatabaseQuery,
} from "@/server/relay-database"

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
    const relayId = relay.id
    return {
      canQuery: true,
      canWrite: false,
      queryKey: ["relay-state-database", relayId],
      overview: () => getRelayStateDatabaseOverview({ data: { relayId } }),
      rows: (input) =>
        getRelayStateDatabaseRows({
          data: { relayId, request: { action: "rows", ...input } },
        }),
      // The viewer only offers writes when `canWrite` is set.
      query: (sql) =>
        runRelayStateDatabaseQuery({
          data: {
            relayId,
            request: { action: "query", maxRows: DATABASE_QUERY_MAX_ROWS, sql },
          },
        }),
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
