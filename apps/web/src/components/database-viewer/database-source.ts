import type {
  DatabaseChange,
  DatabaseMutateResult,
  DatabaseOverview,
  DatabaseQueryResult,
  DatabaseRows,
  DatabaseRowsInput,
} from "@workspace/contracts"

// The viewer only talks to this interface: SQLite files and managed
// MySQL/MariaDB/Postgres databases each supply their own source.
export interface DatabaseSource {
  // Whether the SQL console is offered. Sources decide whether running SQL
  // needs write access.
  canQuery: boolean
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
