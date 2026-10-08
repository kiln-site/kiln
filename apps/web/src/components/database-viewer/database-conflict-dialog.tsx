import type { ReactNode } from "react"

import type {
  DatabaseChange,
  DatabaseTable,
  DatabaseValue,
} from "@workspace/contracts"
import { Button } from "@workspace/ui/components/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@workspace/ui/components/dialog"
import { cn } from "@workspace/ui/lib/utils"

import {
  formatCellValue,
  valuesEqual,
} from "@/components/database-viewer/database-values"

// A staged change the Relay refused because its row changed after loading.
export interface DatabaseSaveConflict {
  change: Extract<DatabaseChange, { kind: "update" | "delete" }>
  // The row as it is now, or null when it was deleted.
  current: Record<string, DatabaseValue> | null
  rowId: string
}

export function DatabaseConflictDialog({
  conflicts,
  onCancel,
  onKeepMine,
  onUseCurrent,
  table,
}: {
  conflicts: ReadonlyArray<DatabaseSaveConflict>
  onCancel: () => void
  onKeepMine: () => void
  onUseCurrent: () => void
  table: DatabaseTable
}) {
  return (
    <Dialog
      open={conflicts.length > 0}
      onOpenChange={(open) => {
        if (!open) onCancel()
      }}
    >
      <DialogContent className="flex max-h-[80vh] flex-col gap-0 p-0 sm:max-w-2xl">
        <DialogHeader className="border-b border-border px-4 py-3">
          <DialogTitle>
            {conflicts.length === 1
              ? "This row changed while you were editing"
              : `${conflicts.length} rows changed while you were editing`}
          </DialogTitle>
          <DialogDescription>
            Nothing has been saved yet. Choose which version to keep.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {conflicts.map((conflict) => (
            <ConflictRow
              key={conflict.rowId}
              conflict={conflict}
              table={table}
            />
          ))}
        </div>
        <DialogFooter className="border-t border-border px-4 py-3">
          <Button variant="outline" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="outline" onClick={onUseCurrent}>
            Use current
          </Button>
          <Button onClick={onKeepMine}>Keep my edits</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ConflictRow({
  conflict: { change, current },
  table,
}: {
  conflict: DatabaseSaveConflict
  table: DatabaseTable
}) {
  const edits = change.kind === "update" ? change.values : {}
  // Only columns someone touched: edited here, or changed underneath.
  const columns = table.columns.filter(
    ({ name }) =>
      name in edits ||
      (current !== null &&
        !valuesEqual(change.original[name] ?? null, current[name] ?? null))
  )

  return (
    <section className="space-y-2">
      <p className="text-xs font-medium">{rowLabel(table, change.original)}</p>
      {current === null ? (
        <p className="text-xs text-muted-foreground">
          It was deleted, so your changes to it can&apos;t be kept.
        </p>
      ) : null}
      {change.kind === "delete" ? (
        <p className="text-xs text-muted-foreground">
          You&apos;re deleting this row.
        </p>
      ) : null}
      {current !== null && columns.length > 0 ? (
        <div className="grid grid-cols-[minmax(5rem,auto)_1fr_1fr_1fr] overflow-hidden rounded-md border border-border text-xs">
          <HeaderCell>Column</HeaderCell>
          <HeaderCell>Original</HeaderCell>
          <HeaderCell>Current</HeaderCell>
          <HeaderCell>Your edit</HeaderCell>
          {columns.map(({ name }) => {
            const original = change.original[name] ?? null
            const now = current[name] ?? null
            const changedUnderneath = !valuesEqual(original, now)
            return (
              <div key={name} className="contents">
                <div className="truncate border-t border-border px-2.5 py-1.5 text-muted-foreground">
                  {name}
                </div>
                <ValueCell value={original} />
                <ValueCell
                  value={now}
                  className={changedUnderneath ? "text-amber-500" : undefined}
                />
                {name in edits ? (
                  <ValueCell
                    value={edits[name] ?? null}
                    className="text-primary"
                  />
                ) : (
                  <div className="border-t border-border px-2.5 py-1.5 text-muted-foreground/45">
                    Unchanged
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : null}
    </section>
  )
}

function HeaderCell({ children }: { children: ReactNode }) {
  return (
    <div className="bg-muted/30 px-2.5 py-1.5 font-medium text-muted-foreground">
      {children}
    </div>
  )
}

function ValueCell({
  className,
  value,
}: {
  className?: string
  value: DatabaseValue
}) {
  const text = value === null ? "NULL" : formatCellValue(value)
  return (
    <div
      title={text}
      className={cn(
        "type-code truncate border-t border-border px-2.5 py-1.5",
        value === null && "text-muted-foreground/45 italic",
        className
      )}
    >
      {text}
    </div>
  )
}

// Names a row the way people recognize it: its key and a readable value.
function rowLabel(
  table: DatabaseTable,
  original: Record<string, DatabaseValue>
) {
  const key = table.columns
    .filter(({ primaryKey }) => primaryKey > 0)
    .map(({ name }) => `${name} ${formatCellValue(original[name] ?? null)}`)
  const readable = table.columns.find(
    ({ name, primaryKey }) =>
      primaryKey === 0 && typeof original[name] === "string"
  )
  return (
    [...key, readable ? formatCellValue(original[readable.name] ?? null) : null]
      .filter(Boolean)
      .join(" · ") || "Row"
  )
}
