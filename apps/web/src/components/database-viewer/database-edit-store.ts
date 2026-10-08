import type {
  DatabaseChange,
  DatabaseRowKey,
  DatabaseValue,
} from "@workspace/contracts"

import { valuesEqual } from "@/components/database-viewer/database-values"

export interface DatabaseEditableRow {
  id: string
  key: DatabaseRowKey
  // Every column of the row as loaded, whatever the grid shows.
  original: Record<string, DatabaseValue>
}

// One loaded row with staged changes. The key and original are captured when
// the first change is staged and never move until Save or Discard: refetches
// update what the grid shows, not what the save checks against.
interface PendingRow {
  deleted: boolean
  key: DatabaseRowKey
  original: Readonly<Record<string, DatabaseValue>>
  values: Readonly<Record<string, DatabaseValue>>
}

export interface InsertedRow {
  id: string
  values: Record<string, DatabaseValue>
}

// Staged grid changes live outside React so an edit re-renders only the
// cells that subscribe to it, not the whole virtualized grid.
// A store belongs to one table for its whole life, so its changes can only
// ever be saved to that table, whatever the viewer shows meanwhile.
export function createDatabaseEditStore(table: string) {
  const listeners = new Set<() => void>()
  let pending = new Map<string, PendingRow>()
  let inserted: ReadonlyArray<InsertedRow> = []
  let pendingCount = 0
  let nextInsertId = 0
  // Set while a save is in flight. The save clears the store when it lands,
  // so anything staged meanwhile would be lost; staging waits instead.
  let locked = false

  function emit() {
    let count = inserted.length
    for (const row of pending.values()) {
      count += row.deleted ? 1 : Object.keys(row.values).length
    }
    pendingCount = count
    for (const listener of listeners) listener()
  }

  // Changes in save order, with the row each came from (null for inserts),
  // so results that refer to a change by position map back to rows.
  function toBatch() {
    const changes: Array<DatabaseChange> = []
    const rowIds: Array<string | null> = []
    for (const [id, { deleted, key, original, values }] of pending) {
      changes.push(
        deleted
          ? { kind: "delete", key, original }
          : { kind: "update", key, original, values }
      )
      rowIds.push(id)
    }
    for (const row of inserted) {
      changes.push({ kind: "insert", values: row.values })
      rowIds.push(null)
    }
    return { changes, rowIds }
  }

  function stage(
    row: DatabaseEditableRow,
    change: (current: PendingRow) => PendingRow
  ) {
    const current = pending.get(row.id) ?? {
      deleted: false,
      key: row.key,
      original: row.original,
      values: {},
    }
    const next = change(current)
    pending = new Map(pending)
    if (!next.deleted && Object.keys(next.values).length === 0) {
      pending.delete(row.id)
    } else {
      pending.set(row.id, next)
    }
    emit()
  }

  return {
    table,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getPendingCount: () => pendingCount,
    getInsertedRows: () => inserted,
    getCellEdit(rowId: string, column: string): DatabaseValue | undefined {
      const values = pending.get(rowId)?.values
      return values && column in values ? values[column] : undefined
    },
    isRowDeleted: (rowId: string) => pending.get(rowId)?.deleted ?? false,
    isLocked: () => locked,
    // Also the "saving" state the UI shows. It lives here, not in a
    // component, so views that remount mid-save still see it.
    setLocked(next: boolean) {
      if (locked === next) return
      locked = next
      emit()
    },
    setCell(row: DatabaseEditableRow, column: string, value: DatabaseValue) {
      if (locked) return
      stage(row, (current) => {
        const values = { ...current.values }
        // Typing a value back to what was loaded drops the edit.
        if (valuesEqual(current.original[column] ?? null, value)) {
          delete values[column]
        } else {
          values[column] = value
        }
        return { ...current, values }
      })
    },
    toggleDeleted(row: DatabaseEditableRow) {
      if (locked) return
      stage(row, (current) => ({ ...current, deleted: !current.deleted }))
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
      if (pending.size === 0 && inserted.length === 0) return
      pending = new Map()
      // Keep the empty array stable so the grid does not re-render.
      if (inserted.length > 0) inserted = []
      emit()
    },
    toBatch,
    toChanges: () => toBatch().changes,
    // After a conflict, the user chose to keep their change: it is restaged
    // against the row as it is now. Edits that now match drop out.
    rebase(rowId: string, current: Record<string, DatabaseValue>) {
      const row = pending.get(rowId)
      if (!row) return
      const values = Object.fromEntries(
        Object.entries(row.values).filter(
          ([column, value]) => !valuesEqual(current[column] ?? null, value)
        )
      )
      pending = new Map(pending)
      if (!row.deleted && Object.keys(values).length === 0) {
        pending.delete(rowId)
      } else {
        pending.set(rowId, { ...row, original: current, values })
      }
      emit()
    },
    drop(rowIds: Iterable<string>) {
      pending = new Map(pending)
      for (const id of rowIds) pending.delete(id)
      emit()
    },
  }
}

export type DatabaseEditStore = ReturnType<typeof createDatabaseEditStore>
