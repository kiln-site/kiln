import type { DatabaseRowKey, DatabaseValue } from "@workspace/contracts"

import { rowKeyId } from "@/components/files/database/database-values"

export type DatabasePageStatus = "error" | "pending" | "success"

export interface DatabasePage {
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
