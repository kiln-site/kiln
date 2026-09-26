import type {
  DatabaseChange,
  DatabaseMutateResult,
  DatabaseOverview,
  DatabaseQueryResult,
  DatabaseRows,
  DatabaseRowsInput,
} from "@workspace/contracts"

import {
  getRelayDatabaseOverview,
  getRelayDatabaseRows,
  mutateRelayDatabase,
  runRelayDatabaseQuery,
} from "@/server/relay"

// The viewer only talks to this interface, so managed MySQL/MariaDB/Postgres
// databases can reuse it by supplying another source.
export interface DatabaseSource {
  canWrite: boolean
  queryKey: ReadonlyArray<unknown>
  overview: () => Promise<DatabaseOverview>
  rows: (input: Omit<DatabaseRowsInput, "action">) => Promise<DatabaseRows>
  query: (sql: string, write: boolean) => Promise<DatabaseQueryResult>
  mutate: (
    table: string,
    changes: Array<DatabaseChange>
  ) => Promise<DatabaseMutateResult>
}

export const DATABASE_PAGE_SIZE = 200
export const DATABASE_QUERY_MAX_ROWS = 1_000

export function relayFileDatabaseSource({
  canWrite,
  instanceId,
  path,
  relayId,
}: {
  canWrite: boolean
  instanceId: string
  path: string
  relayId: string
}): DatabaseSource {
  const target = { instanceId, path, relayId }
  return {
    canWrite,
    queryKey: ["relay", relayId, "instances", instanceId, "database", path],
    overview: () => getRelayDatabaseOverview({ data: target }),
    rows: (input) =>
      getRelayDatabaseRows({
        data: { ...target, request: { action: "rows", ...input } },
      }),
    query: (sql, write) =>
      runRelayDatabaseQuery({
        data: {
          ...target,
          request: { action: "query", maxRows: DATABASE_QUERY_MAX_ROWS, sql },
          write,
        },
      }),
    mutate: (table, changes) =>
      mutateRelayDatabase({
        data: { ...target, request: { action: "mutate", changes, table } },
      }),
  }
}
