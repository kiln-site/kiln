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
  // The value each edited column had when it was first edited. A refetch
  // must not move these, or the save would stop detecting concurrent writes.
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
  // Set while a save is in flight. The save clears the store when it lands,
  // so anything staged meanwhile would be lost; staging waits instead.
  let locked = false

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
    isLocked: () => locked,
    setLocked(next: boolean) {
      locked = next
    },
    setCell(row: DatabaseEditableRow, column: string, value: DatabaseValue) {
      if (locked) return
      const current = edits.get(row.id)
      const values = { ...current?.values }
      const original = { ...current?.original }
      if (!(column in original)) original[column] = row.original[column] ?? null
      if (valuesEqual(original[column] ?? null, value)) {
        delete values[column]
        delete original[column]
      } else {
        values[column] = value
      }
      edits = new Map(edits)
      if (Object.keys(values).length === 0) edits.delete(row.id)
      else edits.set(row.id, { key: row.key, original, values })
      emit()
    },
    toggleDeleted(row: DatabaseEditableRow) {
      if (locked) return
      deleted = new Map(deleted)
      if (deleted.has(row.id)) deleted.delete(row.id)
      else deleted.set(row.id, row.key)
      emit()
    },
    insertRow() {
      if (locked) return null
      const id = `new:${nextInsertId++}`
      inserted = [...inserted, { id, values: {} }]
      emit()
      return id
    },
    setInsertedCell(id: string, column: string, value: DatabaseValue) {
      if (locked) return
      inserted = inserted.map((row) =>
        row.id === id ? { id, values: { ...row.values, [column]: value } } : row
      )
      emit()
    },
    removeInsertedRow(id: string) {
      if (locked) return
      inserted = inserted.filter((row) => row.id !== id)
      emit()
    },
    discard() {
      if (edits.size === 0 && deleted.size === 0 && inserted.length === 0) {
        return
      }
      edits = new Map()
      deleted = new Map()
      // Keep the empty array stable so the grid does not re-render.
      if (inserted.length > 0) inserted = []
      emit()
    },
    toChanges(): Array<DatabaseChange> {
      const changes: Array<DatabaseChange> = []
      for (const [id, edit] of edits) {
        if (deleted.has(id)) continue
        changes.push({
          kind: "update",
          key: edit.key,
          original: edit.original,
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
