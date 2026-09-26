import type {
  DatabaseChange,
  DatabaseRowKey,
  DatabaseValue,
} from "@workspace/contracts"

import { valuesEqual } from "@/components/files/database/database-values"

export interface DatabaseEditableRow {
  id: string
  key: DatabaseRowKey
  original: Record<string, DatabaseValue>
}

interface RowEdit {
  key: DatabaseRowKey
  original: Record<string, DatabaseValue>
  values: Record<string, DatabaseValue>
}

export interface InsertedRow {
  id: string
  values: Record<string, DatabaseValue>
}

// Staged grid changes live outside React so an edit re-renders only the
// cells that subscribe to it, not the whole virtualized grid.
export function createDatabaseEditStore() {
  const listeners = new Set<() => void>()
  let edits = new Map<string, RowEdit>()
  let deleted = new Map<string, DatabaseRowKey>()
  let inserted: ReadonlyArray<InsertedRow> = []
  let pendingCount = 0
  let nextInsertId = 0

  function emit() {
    let count = deleted.size + inserted.length
    for (const [id, edit] of edits) {
      if (!deleted.has(id)) count += Object.keys(edit.values).length
    }
    pendingCount = count
    for (const listener of listeners) listener()
  }

  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getPendingCount: () => pendingCount,
    getInsertedRows: () => inserted,
    getCellEdit(rowId: string, column: string): DatabaseValue | undefined {
      const values = edits.get(rowId)?.values
      return values && column in values ? values[column] : undefined
    },
    isRowDeleted: (rowId: string) => deleted.has(rowId),
    setCell(row: DatabaseEditableRow, column: string, value: DatabaseValue) {
      const current = edits.get(row.id)
      const values = { ...current?.values }
      if (valuesEqual(row.original[column] ?? null, value)) {
        delete values[column]
      } else {
        values[column] = value
      }
      edits = new Map(edits)
      if (Object.keys(values).length === 0) edits.delete(row.id)
      else edits.set(row.id, { key: row.key, original: row.original, values })
      emit()
    },
    toggleDeleted(row: DatabaseEditableRow) {
      deleted = new Map(deleted)
      if (deleted.has(row.id)) deleted.delete(row.id)
      else deleted.set(row.id, row.key)
      emit()
    },
    insertRow() {
      const id = `new:${nextInsertId++}`
      inserted = [...inserted, { id, values: {} }]
      emit()
      return id
    },
    setInsertedCell(id: string, column: string, value: DatabaseValue) {
      inserted = inserted.map((row) =>
        row.id === id ? { id, values: { ...row.values, [column]: value } } : row
      )
      emit()
    },
    removeInsertedRow(id: string) {
      inserted = inserted.filter((row) => row.id !== id)
      emit()
    },
    discard() {
      edits = new Map()
      deleted = new Map()
      inserted = []
      emit()
    },
    toChanges(): Array<DatabaseChange> {
      const changes: Array<DatabaseChange> = []
      for (const [id, edit] of edits) {
        if (deleted.has(id)) continue
        changes.push({
          kind: "update",
          key: edit.key,
          original: Object.fromEntries(
            Object.keys(edit.values).map((column) => [
              column,
              edit.original[column] ?? null,
            ])
          ),
          values: edit.values,
        })
      }
      for (const key of deleted.values()) changes.push({ kind: "delete", key })
      for (const row of inserted) {
        changes.push({ kind: "insert", values: row.values })
      }
      return changes
    },
  }
}

export type DatabaseEditStore = ReturnType<typeof createDatabaseEditStore>
