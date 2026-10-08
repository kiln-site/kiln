import type { DatabaseRowKey, DatabaseValue } from "@workspace/contracts"

import type { DatabaseEditableRow } from "@/components/database-viewer/database-edit-store"
import { rowKeyId } from "@/components/database-viewer/database-values"

export type DatabasePageStatus = "error" | "pending" | "success"

export interface DatabasePage {
  // Every column, in row value order. What the grid shows is its own concern.
  columns: ReadonlyArray<string>
  error: string | null
  keys: ReadonlyArray<DatabaseRowKey> | null
  offset: number
  rowIds: ReadonlyArray<string> | null
  rows: ReadonlyArray<ReadonlyArray<DatabaseValue>>
  status: DatabasePageStatus
  total: number | null
  totalCapped: boolean
}

const emptyPage: DatabasePage = {
  columns: [],
  error: null,
  keys: null,
  offset: 0,
  rowIds: null,
  rows: [],
  status: "pending",
  total: null,
  totalCapped: false,
}

// Rows live outside React so a refetch only re-renders the rows whose data
// changed. Query results are structurally shared, so unchanged rows keep
// their array identity and their subscribers bail out.
export function createDatabasePageStore(initial?: Partial<DatabasePage>) {
  const listeners = new Set<() => void>()
  let page: DatabasePage = {
    ...emptyPage,
    ...initial,
    rowIds: initial?.keys?.map(rowKeyId) ?? null,
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getPage: () => page,
    getError: () => page.error,
    getOffset: () => page.offset,
    getRow: (index: number) => page.rows[index] ?? null,
    getRowCount: () => page.rows.length,
    getRowId: (index: number) => page.rowIds?.[index] ?? null,
    getRowIds: () => page.rowIds,
    // A loaded row as a pending change needs it: its key and every value.
    getRowSnapshot(index: number): DatabaseEditableRow | null {
      const id = page.rowIds?.[index]
      const key = page.keys?.[index]
      const values = page.rows[index]
      if (!id || !key || !values) return null
      return {
        id,
        key,
        original: Object.fromEntries(
          page.columns.map((name, column) => [name, values[column] ?? null])
        ),
      }
    },
    getStatus: () => page.status,
    getTotal: () => page.total,
    getTotalCapped: () => page.totalCapped,
    setPage(next: Omit<DatabasePage, "rowIds">) {
      const rowIds =
        next.keys === page.keys
          ? page.rowIds
          : (next.keys?.map(rowKeyId) ?? null)
      page = { ...next, rowIds }
      for (const listener of listeners) listener()
    },
  }
}

export type DatabasePageStore = ReturnType<typeof createDatabasePageStore>
