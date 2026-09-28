import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import type { DatabaseSort, DatabaseValue } from "@workspace/contracts"
import {
  ArrowDown,
  ArrowUp,
  Ban,
  Copy,
  KeyRound,
  PencilLine,
  RotateCcw,
  Trash2,
} from "lucide-react"

import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@workspace/ui/components/context-menu"
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@workspace/ui/components/tooltip"
import { cn } from "@workspace/ui/lib/utils"

import { copyToClipboard } from "@/components/files/file-viewer-toolbar"
import type {
  DatabaseEditableRow,
  DatabaseEditStore,
  InsertedRow,
} from "@/components/files/database/database-edit-store"
import type { DatabasePageStore } from "@/components/files/database/database-page-store"
import {
  editableText,
  formatCellValue,
  isBlobValue,
  isNumericType,
  isValueEditable,
  parseEditedText,
} from "@/components/files/database/database-values"

export interface DatabaseGridColumn {
  name: string
  type: string | null
  primaryKey?: boolean
  readOnly?: boolean
  // Position of this column's value in each row when some columns are hidden.
  sourceIndex?: number
}

function valueIndex(column: DatabaseGridColumn, position: number) {
  return column.sourceIndex ?? position
}

interface DatabaseGridProps {
  ariaLabel: string
  columns: ReadonlyArray<DatabaseGridColumn>
  editStore: DatabaseEditStore | null
  emptyMessage: string
  onSortChange?: (sort: DatabaseSort | null) => void
  page: DatabasePageStore
  sort?: DatabaseSort | null
}

const ROW_HEIGHT = 30
const HEADER_HEIGHT = 34
const GUTTER_WIDTH = 60
const MIN_COLUMN_WIDTH = 64
const MAX_COLUMN_WIDTH = 1_200
const noopSubscribe = () => () => {}

interface GridPosition {
  column: number
  row: number
}

function createSelectionStore() {
  const listeners = new Set<() => void>()
  let active: GridPosition | null = null
  let editing: { initialText: string | null } | null = null
  let layout = 0
  const emit = () => {
    for (const listener of listeners) listener()
  }
  return {
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getActive: () => active,
    getEditing: () => editing,
    getLayout: () => layout,
    setActive(next: GridPosition | null) {
      if (active?.row === next?.row && active?.column === next?.column) return
      active = next
      editing = null
      emit()
    },
    setEditing(next: { initialText: string | null } | null) {
      editing = next
      emit()
    },
    bumpLayout() {
      layout += 1
      emit()
    },
  }
}

type SelectionStore = ReturnType<typeof createSelectionStore>

interface GridModel {
  columns: ReadonlyArray<DatabaseGridColumn>
  editStore: DatabaseEditStore | null
  inserted: ReadonlyArray<InsertedRow>
  page: DatabasePageStore
}

function initialColumnWidths(
  columns: ReadonlyArray<DatabaseGridColumn>,
  rows: ReadonlyArray<ReadonlyArray<DatabaseValue>>
) {
  const sample = rows.slice(0, 50)
  return columns.map((column, index) => {
    // Header: key icon, name, and sort arrow share the cell.
    let characters = column.name.length + (column.primaryKey ? 2 : 0) + 3
    for (const row of sample) {
      characters = Math.max(
        characters,
        Math.min(
          formatCellValue(row[valueIndex(column, index)] ?? null).length,
          48
        )
      )
    }
    return Math.round(Math.min(Math.max(characters * 7.6 + 26, 88), 360))
  })
}

// The shell only re-renders for structural changes (row count, row identity,
// columns, scrolling). Row data flows from the page store straight to rows.
export const DatabaseGrid = React.memo(function DatabaseGrid({
  ariaLabel,
  columns,
  editStore,
  emptyMessage,
  onSortChange,
  page,
  sort,
}: DatabaseGridProps) {
  const scrollerRef = React.useRef<HTMLDivElement>(null)
  const canvasRef = React.useRef<HTMLDivElement>(null)
  const [selection] = React.useState(createSelectionStore)
  const widthsRef = React.useRef<Array<number>>([])
  const inserted = React.useSyncExternalStore(
    editStore?.subscribe ?? noopSubscribe,
    () => editStore?.getInsertedRows() ?? emptyInserted,
    () => emptyInserted
  )
  const rowCount = React.useSyncExternalStore(
    page.subscribe,
    page.getRowCount,
    page.getRowCount
  )
  const rowIds = React.useSyncExternalStore(
    page.subscribe,
    page.getRowIds,
    page.getRowIds
  )
  const rowNumberOffset = React.useSyncExternalStore(
    page.subscribe,
    page.getOffset,
    page.getOffset
  )
  const totalRows = rowCount + inserted.length
  const editable = Boolean(editStore && rowIds)

  // Widths are sized from the first rows once they arrive, then remembered
  // per column so hiding or showing columns keeps manual resizes.
  const knownWidths = React.useRef(new Map<string, number>())
  const measureWidths = () =>
    initialColumnWidths(columns, page.getPage().rows).map(
      (width, index) =>
        knownWidths.current.get(columns[index]?.name ?? "") ?? width
    )
  const columnSignature = columns.map(({ name }) => name).join("\u0000")
  const [widths, setWidths] = React.useState(measureWidths)
  const [widthSignature, setWidthSignature] = React.useState(() => ({
    columns: columnSignature,
    sampled: rowCount > 0,
  }))
  if (
    widthSignature.columns !== columnSignature ||
    (!widthSignature.sampled && rowCount > 0)
  ) {
    setWidthSignature({ columns: columnSignature, sampled: rowCount > 0 })
    setWidths(measureWidths())
  }
  React.useEffect(() => {
    if (!widthSignature.sampled) return
    widths.forEach((width, index) => {
      const name = columns[index]?.name
      if (name !== undefined) knownWidths.current.set(name, width)
    })
  }, [columns, widthSignature.sampled, widths])
  widthsRef.current = widths
  const totalWidth =
    GUTTER_WIDTH + widths.reduce((sum, width) => sum + width, 0)
  // The last column takes up any room left of the viewport so the grid never
  // ends in an empty filler column.
  const cellStyles = React.useMemo(
    () =>
      columns.map(
        (_, index): React.CSSProperties => ({
          flexGrow: index === columns.length - 1 ? 1 : undefined,
          width: `var(--db-col-${index})`,
        })
      ),
    [columns]
  )
  const canvasStyle = React.useMemo(() => {
    const style: Record<string, string> = {
      width: `${totalWidth}px`,
    }
    widths.forEach((width, index) => {
      style[`--db-col-${index}`] = `${width}px`
    })
    return style as React.CSSProperties
  }, [totalWidth, widths])

  const model = React.useRef<GridModel>({ columns, editStore, inserted, page })
  model.current = { columns, editStore, inserted, page }

  const virtualizer = useVirtualizer({
    count: totalRows,
    estimateSize: () => ROW_HEIGHT,
    getScrollElement: () => scrollerRef.current,
    overscan: 12,
    scrollPaddingStart: HEADER_HEIGHT,
  })

  // A new page or result set clears the selection; background refetches of
  // the same page keep it so an open editor is not interrupted.
  React.useEffect(() => {
    selection.setActive(null)
  }, [columnSignature, rowNumberOffset, selection])
  React.useEffect(() => {
    const active = selection.getActive()
    if (active && active.row >= totalRows) selection.setActive(null)
  }, [selection, totalRows])

  const resizeColumn = React.useCallback(
    (index: number, width: number) => {
      const next = Math.round(
        Math.min(Math.max(width, MIN_COLUMN_WIDTH), MAX_COLUMN_WIDTH)
      )
      widthsRef.current = widthsRef.current.map((current, position) =>
        position === index ? next : current
      )
      const canvas = canvasRef.current
      if (canvas) {
        // Dragging updates CSS variables directly; React state is written once
        // the pointer is released so rows never re-render mid-drag.
        canvas.style.setProperty(`--db-col-${index}`, `${next}px`)
        canvas.style.width = `${GUTTER_WIDTH + widthsRef.current.reduce((sum, value) => sum + value, 0)}px`
      }
      selection.bumpLayout()
    },
    [selection]
  )
  const commitWidths = React.useCallback(() => {
    setWidths(widthsRef.current)
  }, [])

  const scrollIntoView = React.useCallback(
    (position: GridPosition) => {
      virtualizer.scrollToIndex(position.row, { align: "auto" })
      const scroller = scrollerRef.current
      if (!scroller) return
      const left = columnLeft(widthsRef.current, position.column)
      const right = left + (widthsRef.current[position.column] ?? 0)
      if (left - GUTTER_WIDTH < scroller.scrollLeft) {
        scroller.scrollLeft = left - GUTTER_WIDTH
      } else if (right > scroller.scrollLeft + scroller.clientWidth) {
        scroller.scrollLeft = right - scroller.clientWidth
      }
    },
    [virtualizer]
  )

  const moveTo = React.useCallback(
    (position: GridPosition) => {
      const current = model.current
      const rowCount = current.page.getRowCount() + current.inserted.length
      if (rowCount === 0 || current.columns.length === 0) return
      const next = {
        column: clamp(position.column, 0, current.columns.length - 1),
        row: clamp(position.row, 0, rowCount - 1),
      }
      selection.setActive(next)
      scrollIntoView(next)
    },
    [scrollIntoView, selection]
  )

  // Jump to a freshly added row so it can be filled in right away. Integer
  // primary keys are usually generated, so the first other column is picked.
  const insertedCount = React.useRef(inserted.length)
  React.useEffect(() => {
    const added = inserted.length > insertedCount.current
    insertedCount.current = inserted.length
    if (!added) return
    const column = columns.findIndex(
      ({ primaryKey, readOnly, type }) =>
        !readOnly && !(primaryKey && /INT/iu.test(type ?? ""))
    )
    moveTo({
      column: Math.max(column, 0),
      row: page.getRowCount() + inserted.length - 1,
    })
    scrollerRef.current?.focus({ preventScroll: true })
  }, [columns, inserted.length, moveTo, page])

  const beginEdit = React.useCallback(
    (initialText: string | null) => {
      const active = selection.getActive()
      if (!active || !canEditCell(model.current, active)) return
      // Edits wait while a save is in flight; see the edit store's lock.
      if (model.current.editStore?.isLocked()) return
      selection.setEditing({ initialText })
    },
    [selection]
  )

  const commitEdit = React.useCallback(
    (target: CellTarget | null, value: DatabaseValue) => {
      if (target && model.current.editStore) {
        applyToTarget(model.current.editStore, target, value)
      }
      selection.setEditing(null)
      scrollerRef.current?.focus({ preventScroll: true })
    },
    [selection]
  )

  const cancelEdit = React.useCallback(() => {
    selection.setEditing(null)
    scrollerRef.current?.focus({ preventScroll: true })
  }, [selection])

  const commitAndMove = React.useCallback(
    (
      target: CellTarget | null,
      position: GridPosition,
      value: DatabaseValue,
      delta: (position: GridPosition) => Partial<GridPosition>
    ) => {
      commitEdit(target, value)
      moveTo({ ...position, ...delta(position) })
    },
    [commitEdit, moveTo]
  )

  const editActiveCell = React.useCallback(() => beginEdit(null), [beginEdit])
  // Commits the open cell editor, if any; set by the editor while mounted.
  const flushEditRef = React.useRef<(() => void) | null>(null)

  function handlePointerDown(event: React.PointerEvent<HTMLDivElement>) {
    const position = cellFromEvent(event)
    if (!position) return
    if (event.button === 0 || event.button === 2) {
      flushEditRef.current?.()
      selection.setActive(position)
    }
  }

  function handleDoubleClick(event: React.MouseEvent<HTMLDivElement>) {
    const position = cellFromEvent(event)
    if (!position) return
    flushEditRef.current?.()
    selection.setActive(position)
    beginEdit(null)
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return
    const active = selection.getActive()
    const modifier = event.metaKey || event.ctrlKey
    if (!active) {
      if (
        ["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Tab"].includes(
          event.key
        )
      ) {
        event.preventDefault()
        moveTo({ column: 0, row: 0 })
      }
      return
    }
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        moveTo({ ...active, row: modifier ? Infinity : active.row + 1 })
        return
      case "ArrowUp":
        event.preventDefault()
        moveTo({ ...active, row: modifier ? 0 : active.row - 1 })
        return
      case "ArrowRight":
        event.preventDefault()
        moveTo({
          ...active,
          column: modifier ? Infinity : active.column + 1,
        })
        return
      case "ArrowLeft":
        event.preventDefault()
        moveTo({ ...active, column: modifier ? 0 : active.column - 1 })
        return
      case "PageDown":
      case "PageUp": {
        event.preventDefault()
        const page = Math.max(
          1,
          Math.floor(
            ((scrollerRef.current?.clientHeight ?? 0) - HEADER_HEIGHT) /
              ROW_HEIGHT
          )
        )
        moveTo({
          ...active,
          row: active.row + (event.key === "PageDown" ? page : -page),
        })
        return
      }
      case "Tab":
        event.preventDefault()
        moveTo({
          ...active,
          column: active.column + (event.shiftKey ? -1 : 1),
        })
        return
      case "Enter":
      case "F2":
        event.preventDefault()
        beginEdit(null)
        return
      case "Escape":
        selection.setActive(null)
        return
    }
    if (modifier && event.key.toLowerCase() === "c") {
      event.preventDefault()
      void copyToClipboard(editableText(cellValue(model.current, active)))
      return
    }
    if (
      event.key.length === 1 &&
      !modifier &&
      !event.altKey &&
      canEditCell(model.current, active)
    ) {
      event.preventDefault()
      beginEdit(event.key)
    }
  }

  const virtualRows = virtualizer.getVirtualItems()

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          ref={scrollerRef}
          role="grid"
          aria-label={ariaLabel}
          aria-rowcount={totalRows + 1}
          aria-colcount={columns.length}
          tabIndex={0}
          className="relative min-h-0 flex-1 overflow-auto overscroll-contain bg-card [contain:strict] outline-none focus-visible:ring-1 focus-visible:ring-primary/35 focus-visible:ring-inset"
          onPointerDown={handlePointerDown}
          onDoubleClick={handleDoubleClick}
          onKeyDown={handleKeyDown}
        >
          <div
            ref={canvasRef}
            className="relative min-w-full"
            style={{
              ...canvasStyle,
              height: HEADER_HEIGHT + virtualizer.getTotalSize(),
            }}
          >
            <GridHeader
              cellStyles={cellStyles}
              columns={columns}
              onResize={resizeColumn}
              onResizeEnd={commitWidths}
              onSortChange={onSortChange}
              sort={sort ?? null}
              widthsRef={widthsRef}
            />
            {virtualRows.map((virtualRow) => {
              const index = virtualRow.index
              const insertedRow =
                index >= rowCount ? inserted[index - rowCount] : null
              return (
                <GridRow
                  key={insertedRow?.id ?? rowIds?.[index] ?? index}
                  cellStyles={cellStyles}
                  columns={columns}
                  editStore={editStore}
                  inserted={insertedRow}
                  label={
                    insertedRow ? "+" : String(rowNumberOffset + index + 1)
                  }
                  page={insertedRow ? null : page}
                  rowId={insertedRow ? null : (rowIds?.[index] ?? null)}
                  rowIndex={index}
                  top={virtualRow.start + HEADER_HEIGHT}
                />
              )
            })}
            <SelectionOverlay selection={selection} widthsRef={widthsRef} />
            <CellEditor
              flushRef={flushEditRef}
              model={model}
              selection={selection}
              widthsRef={widthsRef}
              onCancel={cancelEdit}
              onCommit={commitEdit}
              onCommitAndMove={commitAndMove}
            />
          </div>
          {totalRows === 0 ? (
            <div
              className="pointer-events-none sticky left-0 grid h-[calc(100%-34px)] w-full place-items-center px-6 text-center text-xs text-muted-foreground"
              style={{ maxWidth: "100%" }}
            >
              {emptyMessage}
            </div>
          ) : null}
        </div>
      </ContextMenuTrigger>
      <GridContextMenu
        editable={editable}
        model={model}
        selection={selection}
        onEdit={editActiveCell}
      />
    </ContextMenu>
  )
})

const emptyInserted: ReadonlyArray<InsertedRow> = []

const GridHeader = React.memo(function GridHeader({
  cellStyles,
  columns,
  onResize,
  onResizeEnd,
  onSortChange,
  sort,
  widthsRef,
}: {
  cellStyles: ReadonlyArray<React.CSSProperties>
  columns: ReadonlyArray<DatabaseGridColumn>
  onResize: (index: number, width: number) => void
  onResizeEnd: () => void
  onSortChange?: (sort: DatabaseSort | null) => void
  sort: DatabaseSort | null
  widthsRef: React.RefObject<Array<number>>
}) {
  function startResize(index: number, event: React.PointerEvent) {
    event.preventDefault()
    event.stopPropagation()
    const startX = event.clientX
    const target = event.currentTarget as HTMLElement
    // Measured, since a stretched last column is wider than its set width.
    const startWidth =
      target.parentElement?.getBoundingClientRect().width ??
      widthsRef.current[index] ??
      120
    target.setPointerCapture(event.pointerId)
    const move = (moveEvent: PointerEvent) =>
      onResize(index, startWidth + moveEvent.clientX - startX)
    const end = () => {
      target.removeEventListener("pointermove", move)
      target.removeEventListener("pointerup", end)
      target.removeEventListener("pointercancel", end)
      onResizeEnd()
    }
    target.addEventListener("pointermove", move)
    target.addEventListener("pointerup", end)
    target.addEventListener("pointercancel", end)
  }

  return (
    <div
      role="row"
      className="sticky top-0 z-20 flex border-b border-border bg-muted/40 backdrop-blur-sm"
      style={{ height: HEADER_HEIGHT }}
    >
      <div
        className="sticky left-0 z-10 shrink-0 border-r border-border bg-card"
        style={{ width: GUTTER_WIDTH }}
        aria-hidden="true"
      />
      {columns.map((column, index) => {
        const sorted = sort?.column === column.name ? sort.direction : null
        return (
          <div
            key={column.name}
            role="columnheader"
            aria-sort={
              sorted === "asc"
                ? "ascending"
                : sorted === "desc"
                  ? "descending"
                  : "none"
            }
            className="group/header relative flex shrink-0 items-center border-r border-border bg-card"
            style={cellStyles[index]}
          >
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-2.5 text-left outline-none focus-visible:bg-accent/50 enabled:hover:bg-accent/40 disabled:cursor-default"
                  disabled={!onSortChange}
                  onClick={() =>
                    onSortChange?.(
                      sorted === null
                        ? { column: column.name, direction: "asc" }
                        : sorted === "asc"
                          ? { column: column.name, direction: "desc" }
                          : null
                    )
                  }
                >
                  {column.primaryKey ? (
                    <KeyRound className="size-3 shrink-0 text-primary" />
                  ) : null}
                  <span className="truncate text-xs font-semibold text-foreground">
                    {column.name}
                  </span>
                  {sorted === "asc" ? (
                    <ArrowUp className="ml-auto size-3.5 shrink-0 text-primary" />
                  ) : sorted === "desc" ? (
                    <ArrowDown className="ml-auto size-3.5 shrink-0 text-primary" />
                  ) : null}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                <ColumnTooltip column={column} />
              </TooltipContent>
            </Tooltip>
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label={`Resize ${column.name}`}
              className={cn(
                "absolute inset-y-0 z-10 w-2 cursor-col-resize touch-none after:absolute after:inset-y-1.5 after:left-[3px] after:w-0.5 after:bg-primary/60 after:opacity-0 after:transition-opacity hover:after:opacity-100",
                // The last grip stays inside the grid so it adds no overflow.
                index === columns.length - 1 ? "right-0" : "-right-1"
              )}
              onPointerDown={(event) => startResize(index, event)}
            />
          </div>
        )
      })}
    </div>
  )
})

function ColumnTooltip({ column }: { column: DatabaseGridColumn }) {
  const traits = [
    column.primaryKey ? "Primary key" : null,
    column.readOnly ? "Generated" : null,
  ].filter(Boolean)
  return (
    <span className="flex flex-col gap-0.5">
      <span className="font-mono uppercase">
        {column.type || "No declared type"}
      </span>
      {traits.length > 0 ? (
        <span className="opacity-70">{traits.join(" · ")}</span>
      ) : null}
    </span>
  )
}

// Alternate rows get a faint lift. It is an opaque mix so the sticky row
// number gutter can share it without content showing through.
const stripedRowClassName =
  "bg-[color-mix(in_oklch,var(--card),var(--foreground)_4.5%)]"

const GridRow = React.memo(function GridRow({
  cellStyles,
  columns,
  editStore,
  inserted,
  label,
  page,
  rowId,
  rowIndex,
  top,
}: {
  cellStyles: ReadonlyArray<React.CSSProperties>
  columns: ReadonlyArray<DatabaseGridColumn>
  editStore: DatabaseEditStore | null
  inserted: InsertedRow | null
  label: string
  page: DatabasePageStore | null
  rowId: string | null
  rowIndex: number
  top: number
}) {
  // Each row reads only its own data, so a refetch that changes one row
  // re-renders only that row.
  const values = React.useSyncExternalStore(
    page?.subscribe ?? noopSubscribe,
    () => page?.getRow(rowIndex) ?? null,
    () => null
  )
  const deleted = React.useSyncExternalStore(
    rowId && editStore ? editStore.subscribe : noopSubscribe,
    () => (rowId && editStore ? editStore.isRowDeleted(rowId) : false),
    () => false
  )
  return (
    <div
      role="row"
      aria-rowindex={rowIndex + 2}
      className={cn(
        "absolute top-0 left-0 flex w-full border-b border-border/45",
        rowIndex % 2 === 1 && stripedRowClassName,
        inserted && "bg-emerald-500/[0.07]",
        deleted && "bg-destructive/[0.08] text-muted-foreground line-through"
      )}
      style={{ height: ROW_HEIGHT, transform: `translateY(${top}px)` }}
    >
      <div
        className={cn(
          "type-code sticky left-0 z-10 flex shrink-0 items-center justify-end border-r border-border bg-card pr-2.5 text-[0.6875rem] text-muted-foreground/65 tabular-nums",
          rowIndex % 2 === 1 && stripedRowClassName,
          inserted && "text-emerald-500",
          deleted && "text-destructive"
        )}
        style={{ width: GUTTER_WIDTH }}
      >
        {label}
      </div>
      {columns.map((column, columnIndex) => (
        <GridCell
          key={column.name}
          column={column}
          columnIndex={columnIndex}
          editStore={inserted ? null : editStore}
          rowId={rowId}
          rowIndex={rowIndex}
          style={cellStyles[columnIndex]}
          value={
            inserted
              ? column.name in inserted.values
                ? (inserted.values[column.name] ?? null)
                : undefined
              : (values?.[valueIndex(column, columnIndex)] ?? null)
          }
        />
      ))}
    </div>
  )
})

const GridCell = React.memo(function GridCell({
  column,
  columnIndex,
  editStore,
  rowId,
  rowIndex,
  style,
  value,
}: {
  column: DatabaseGridColumn
  columnIndex: number
  editStore: DatabaseEditStore | null
  rowId: string | null
  rowIndex: number
  style: React.CSSProperties | undefined
  // undefined marks an inserted cell left to the column default.
  value: DatabaseValue | undefined
}) {
  const edit = React.useSyncExternalStore(
    rowId && editStore ? editStore.subscribe : noopSubscribe,
    () =>
      rowId && editStore
        ? editStore.getCellEdit(rowId, column.name)
        : undefined,
    () => undefined
  )
  const edited = edit !== undefined
  const display = edited ? edit : value
  const numeric = isNumericType(column.type)
  return (
    <div
      role="gridcell"
      data-row={rowIndex}
      data-column={columnIndex}
      className={cn(
        "type-code flex shrink-0 items-center overflow-hidden border-r border-border px-2.5 text-[0.8125rem] leading-none whitespace-nowrap select-none",
        numeric && "justify-end tabular-nums",
        edited && "bg-primary/12 text-primary"
      )}
      style={style}
    >
      {display === undefined ? (
        <span className="text-muted-foreground/45 italic">DEFAULT</span>
      ) : display === null ? (
        <span className="text-muted-foreground/45 italic">NULL</span>
      ) : isBlobValue(display) ? (
        <span className="text-muted-foreground/70">
          {formatCellValue(display)}
        </span>
      ) : (
        <span className="truncate">{formatCellValue(display)}</span>
      )}
    </div>
  )
})

const SelectionOverlay = React.memo(function SelectionOverlay({
  selection,
  widthsRef,
}: {
  selection: SelectionStore
  widthsRef: React.RefObject<Array<number>>
}) {
  const active = React.useSyncExternalStore(
    selection.subscribe,
    selection.getActive,
    selection.getActive
  )
  React.useSyncExternalStore(
    selection.subscribe,
    selection.getLayout,
    selection.getLayout
  )
  if (!active) return null
  const left = columnLeft(widthsRef.current, active.column)
  const width = widthsRef.current[active.column] ?? 0
  const top = HEADER_HEIGHT + active.row * ROW_HEIGHT
  const stretched = isLastColumn(widthsRef.current, active.column)
  return (
    <>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-0 left-0 w-full bg-primary/[0.045]"
        style={{ height: ROW_HEIGHT - 1, transform: `translateY(${top}px)` }}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute z-[5] ring-2 ring-primary ring-inset"
        style={{
          height: ROW_HEIGHT,
          left,
          top: top - 1,
          ...(stretched ? { right: 0 } : { width: width + 1 }),
        }}
      />
    </>
  )
})

const CellEditor = React.memo(function CellEditor({
  flushRef,
  model,
  onCancel,
  onCommit,
  onCommitAndMove,
  selection,
  widthsRef,
}: {
  flushRef: React.RefObject<(() => void) | null>
  model: React.RefObject<GridModel>
  onCancel: () => void
  onCommit: (target: CellTarget | null, value: DatabaseValue) => void
  onCommitAndMove: (
    target: CellTarget | null,
    position: GridPosition,
    value: DatabaseValue,
    delta: (position: GridPosition) => Partial<GridPosition>
  ) => void
  selection: SelectionStore
  widthsRef: React.RefObject<Array<number>>
}) {
  const editing = React.useSyncExternalStore(
    selection.subscribe,
    selection.getEditing,
    selection.getEditing
  )
  const active = selection.getActive()
  if (!editing || !active) return null
  return (
    <ActiveCellEditor
      key={`${active.row}:${active.column}`}
      flushRef={flushRef}
      initialText={editing.initialText}
      model={model}
      position={active}
      widthsRef={widthsRef}
      onCancel={onCancel}
      onCommit={onCommit}
      onCommitAndMove={onCommitAndMove}
    />
  )
})

function ActiveCellEditor({
  flushRef,
  initialText,
  model,
  onCancel,
  onCommit,
  onCommitAndMove,
  position,
  widthsRef,
}: {
  flushRef: React.RefObject<(() => void) | null>
  initialText: string | null
  model: React.RefObject<GridModel>
  onCancel: () => void
  onCommit: (target: CellTarget | null, value: DatabaseValue) => void
  onCommitAndMove: (
    target: CellTarget | null,
    position: GridPosition,
    value: DatabaseValue,
    delta: (position: GridPosition) => Partial<GridPosition>
  ) => void
  position: GridPosition
  widthsRef: React.RefObject<Array<number>>
}) {
  // The row, column, and value are captured when editing starts, so a
  // refetch that shifts rows meanwhile cannot redirect the edit.
  const [start] = React.useState(() => ({
    column: model.current.columns[position.column],
    target: cellTarget(model.current, position),
    value: cellValue(model.current, position),
  }))
  const { column, target, value: current } = start
  const [text, setText] = React.useState(
    () => initialText ?? editableText(current)
  )
  const settled = React.useRef(false)
  const inputRef = React.useRef<HTMLTextAreaElement>(null)

  React.useLayoutEffect(() => {
    const input = inputRef.current
    if (!input) return
    input.focus({ preventScroll: true })
    const end = input.value.length
    input.setSelectionRange(end, end)
  }, [])

  const lines = Math.min(text.split("\n").length, 8)
  const left = columnLeft(widthsRef.current, position.column)
  const width = Math.max(widthsRef.current[position.column] ?? 0, 220)
  const stretched = isLastColumn(widthsRef.current, position.column)
  const value = () => parseEditedText(text, current, column ?? undefined)
  const commit = () => {
    if (settled.current) return
    settled.current = true
    onCommit(target, value())
  }

  // Selecting another cell unmounts this editor before it would blur, so the
  // grid flushes it first instead of dropping the typed value.
  React.useLayoutEffect(() => {
    flushRef.current = commit
  })
  React.useLayoutEffect(
    () => () => {
      flushRef.current = null
    },
    [flushRef]
  )

  return (
    <textarea
      ref={inputRef}
      aria-label={`Edit ${column?.name ?? "cell"}`}
      value={text}
      spellCheck={false}
      rows={lines}
      className="type-code absolute z-30 resize-none border-0 bg-popover px-2.5 py-[7px] text-[0.8125rem] leading-4 text-foreground shadow-lg ring-2 ring-primary outline-none"
      style={{
        left,
        minHeight: ROW_HEIGHT,
        top: HEADER_HEIGHT + position.row * ROW_HEIGHT - 1,
        ...(stretched ? { minWidth: 220, right: 0 } : { width }),
      }}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        event.stopPropagation()
        if (event.key === "Escape") {
          event.preventDefault()
          settled.current = true
          onCancel()
          return
        }
        if (event.key === "Enter" && !event.shiftKey && !event.altKey) {
          event.preventDefault()
          settled.current = true
          onCommitAndMove(target, position, value(), (cell) => ({
            row: cell.row + 1,
          }))
          return
        }
        if (event.key === "Tab") {
          event.preventDefault()
          settled.current = true
          onCommitAndMove(target, position, value(), (cell) => ({
            column: cell.column + (event.shiftKey ? -1 : 1),
          }))
        }
      }}
    />
  )
}

const GridContextMenu = React.memo(function GridContextMenu(
  props: GridContextMenuProps
) {
  return (
    <ContextMenuContent className="w-56">
      <GridContextMenuItems {...props} />
    </ContextMenuContent>
  )
})

interface GridContextMenuProps {
  editable: boolean
  model: React.RefObject<GridModel>
  onEdit: () => void
  selection: SelectionStore
}

// Menu content mounts when it opens, so reading the active cell here keeps
// selection changes from re-rendering the menu.
function GridContextMenuItems({
  editable,
  model,
  onEdit,
  selection,
}: GridContextMenuProps) {
  const active = selection.getActive()
  if (!active) {
    return <ContextMenuItem disabled>Select a cell</ContextMenuItem>
  }
  const current = model.current
  const value = cellValue(current, active)
  const row = rowForPosition(current, active)
  const rowCount = current.page.getRowCount()
  const insertedRow =
    active.row >= rowCount ? current.inserted[active.row - rowCount] : null
  const deleted = row && current.editStore?.isRowDeleted(row.id)
  const cellEditable = editable && canEditCell(current, active)
  const column = current.columns[active.column]

  return (
    <>
      <ContextMenuItem
        onSelect={() => void copyToClipboard(editableText(value))}
      >
        <Copy /> Copy value
      </ContextMenuItem>
      <ContextMenuItem
        onSelect={() =>
          void copyToClipboard(
            JSON.stringify(rowObject(current, active.row), null, 2)
          )
        }
      >
        <Copy /> Copy row as JSON
      </ContextMenuItem>
      {editable ? (
        <>
          <ContextMenuSeparator />
          <ContextMenuItem disabled={!cellEditable} onSelect={onEdit}>
            <PencilLine /> Edit {column?.name}
          </ContextMenuItem>
          <ContextMenuItem
            disabled={!cellEditable || value === null}
            onSelect={() => applyCellValue(current, active, null)}
          >
            <Ban /> Set NULL
          </ContextMenuItem>
          <ContextMenuSeparator />
          {insertedRow ? (
            <ContextMenuItem
              variant="destructive"
              onSelect={() =>
                current.editStore?.removeInsertedRow(insertedRow.id)
              }
            >
              <Trash2 /> Remove new row
            </ContextMenuItem>
          ) : row ? (
            <ContextMenuItem
              variant={deleted ? "default" : "destructive"}
              onSelect={() => current.editStore?.toggleDeleted(row)}
            >
              {deleted ? <RotateCcw /> : <Trash2 />}
              {deleted ? "Restore row" : "Delete row"}
            </ContextMenuItem>
          ) : null}
        </>
      ) : null}
    </>
  )
}

function cellFromEvent(event: React.SyntheticEvent): GridPosition | null {
  const cell = (event.target as HTMLElement).closest<HTMLElement>(
    "[data-row][data-column]"
  )
  if (!cell) return null
  return {
    column: Number(cell.dataset.column),
    row: Number(cell.dataset.row),
  }
}

function columnLeft(widths: ReadonlyArray<number>, column: number) {
  let left = GUTTER_WIDTH
  for (let index = 0; index < column; index += 1) left += widths[index] ?? 0
  return left
}

// The last column stretches to fill the grid, so overlays anchor to its edge.
function isLastColumn(widths: ReadonlyArray<number>, column: number) {
  return column === widths.length - 1
}

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max)
}

function cellValue(model: GridModel, position: GridPosition): DatabaseValue {
  const column = model.columns[position.column]
  if (!column) return null
  const { rowIds, rows } = model.page.getPage()
  if (position.row >= rows.length) {
    const inserted = model.inserted[position.row - rows.length]
    return inserted?.values[column.name] ?? null
  }
  const rowId = rowIds?.[position.row]
  const edit = rowId
    ? model.editStore?.getCellEdit(rowId, column.name)
    : undefined
  return edit !== undefined
    ? edit
    : (rows[position.row]?.[valueIndex(column, position.column)] ?? null)
}

function rowForPosition(
  model: GridModel,
  position: GridPosition
): DatabaseEditableRow | null {
  const { keys, rowIds, rows } = model.page.getPage()
  const id = rowIds?.[position.row]
  const key = keys?.[position.row]
  const values = rows[position.row]
  if (!id || !key || !values) return null
  return {
    id,
    key,
    original: Object.fromEntries(
      model.columns.map((column, index) => [
        column.name,
        values[valueIndex(column, index)] ?? null,
      ])
    ),
  }
}

function canEditCell(model: GridModel, position: GridPosition) {
  if (!model.editStore) return false
  const column = model.columns[position.column]
  if (!column || column.readOnly) return false
  const rows = model.page.getPage().rows
  if (position.row >= rows.length) return true
  const row = rowForPosition(model, position)
  if (!row || model.editStore.isRowDeleted(row.id)) return false
  return isValueEditable(
    rows[position.row]?.[valueIndex(column, position.column)] ?? null
  )
}

// Where a cell edit lands: a loaded row (with the values it had) or a staged
// insert. Resolved from the current page, so hold on to it across refetches.
type CellTarget =
  | { column: string; row: DatabaseEditableRow }
  | { column: string; insertedId: string }

function cellTarget(
  model: GridModel,
  position: GridPosition
): CellTarget | null {
  const column = model.columns[position.column]
  if (!column) return null
  const rowCount = model.page.getRowCount()
  if (position.row >= rowCount) {
    const inserted = model.inserted[position.row - rowCount]
    return inserted ? { column: column.name, insertedId: inserted.id } : null
  }
  const row = rowForPosition(model, position)
  return row ? { column: column.name, row } : null
}

function applyToTarget(
  editStore: DatabaseEditStore,
  target: CellTarget,
  value: DatabaseValue
) {
  if ("row" in target) editStore.setCell(target.row, target.column, value)
  else editStore.setInsertedCell(target.insertedId, target.column, value)
}

function applyCellValue(
  model: GridModel,
  position: GridPosition,
  value: DatabaseValue
) {
  const target = cellTarget(model, position)
  if (target && model.editStore) applyToTarget(model.editStore, target, value)
}

function rowObject(model: GridModel, rowIndex: number) {
  return Object.fromEntries(
    model.columns.map((column, index) => {
      const value = cellValue(model, { column: index, row: rowIndex })
      return [
        column.name,
        value !== null && typeof value === "object"
          ? isBlobValue(value)
            ? `<blob ${value.size} bytes>`
            : value.$bigint
          : value,
      ]
    })
  )
}
