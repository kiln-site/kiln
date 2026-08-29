import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  FlexRender,
  Subscribe,
  type Row,
  type RowData,
  type Table,
} from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ArrowUpDown } from "lucide-react"

import { cn } from "@workspace/ui/lib/utils"
import { dataTableFeatures } from "@/lib/data-table"

type DataTableInstance<TData extends RowData> = Table<
  typeof dataTableFeatures,
  TData
>

interface DataTableVirtualizationOptions {
  estimateRowHeight?: number
  overscan?: number
}

interface DataTableProps<TData extends RowData> {
  ariaLabel: string
  emptyState: React.ReactNode
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  gridClassName: string
  table: DataTableInstance<TData>
  virtualization?: DataTableVirtualizationOptions
}

export function DataTable<TData extends RowData>({
  ariaLabel,
  emptyState,
  getRowClassName,
  gridClassName,
  table,
  virtualization,
}: DataTableProps<TData>) {
  return (
    <Subscribe
      source={table.atoms.globalFilter}
      selector={() => table.getRowModel().rows.map((row) => row.id)}
    >
      {() => (
        <Subscribe
          source={table.atoms.columnFilters}
          selector={() => table.getRowModel().rows.map((row) => row.id)}
        >
          {() => (
            <Subscribe
              source={table.atoms.sorting}
              selector={() => table.getRowModel().rows.map((row) => row.id)}
            >
              {() => (
                <DataTableRowModel
                  ariaLabel={ariaLabel}
                  emptyState={emptyState}
                  getRowClassName={getRowClassName}
                  gridClassName={gridClassName}
                  table={table}
                  virtualization={virtualization}
                />
              )}
            </Subscribe>
          )}
        </Subscribe>
      )}
    </Subscribe>
  )
}

function DataTableRowModel<TData extends RowData>({
  ariaLabel,
  emptyState,
  getRowClassName,
  gridClassName,
  table,
  virtualization,
}: DataTableProps<TData>) {
  const rows = table.getRowModel().rows
  const scrollElementRef = React.useRef<HTMLTableSectionElement>(null)
  const scrollbarWidth = useScrollbarWidth(scrollElementRef, rows.length)

  if (rows.length === 0) return emptyState

  return (
    <table
      aria-colcount={table.getAllLeafColumns().length}
      aria-label={ariaLabel}
      aria-rowcount={rows.length + 1}
      className="flex h-full min-h-0 w-full min-w-0 border-collapse flex-col overflow-hidden pb-px text-left"
    >
      <MemoizedDataTableHead
        gridClassName={gridClassName}
        scrollbarWidth={scrollbarWidth}
        table={table}
      />
      {virtualization ? (
        <VirtualDataTableBody
          getRowClassName={getRowClassName}
          gridClassName={gridClassName}
          rows={rows}
          scrollElementRef={scrollElementRef}
          virtualization={virtualization}
        />
      ) : (
        <DataTableBody
          getRowClassName={getRowClassName}
          gridClassName={gridClassName}
          rows={rows}
          scrollElementRef={scrollElementRef}
        />
      )}
    </table>
  )
}

function useScrollbarWidth(
  scrollElementRef: React.RefObject<HTMLElement | null>,
  rowCount: number
) {
  const [scrollbarWidth, setScrollbarWidth] = React.useState(0)

  React.useLayoutEffect(() => {
    const scrollElement = scrollElementRef.current
    if (!scrollElement) return

    const updateScrollbarWidth = () => {
      const nextWidth = scrollElement.offsetWidth - scrollElement.clientWidth
      setScrollbarWidth((currentWidth) =>
        currentWidth === nextWidth ? currentWidth : nextWidth
      )
    }
    const resizeObserver = new ResizeObserver(updateScrollbarWidth)

    updateScrollbarWidth()
    resizeObserver.observe(scrollElement)
    return () => resizeObserver.disconnect()
  }, [rowCount, scrollElementRef])

  return scrollbarWidth
}

function DataTableHead<TData extends RowData>({
  gridClassName,
  scrollbarWidth,
  table,
}: {
  gridClassName: string
  scrollbarWidth: number
  table: DataTableInstance<TData>
}) {
  return (
    <thead
      className="z-20 block shrink-0 bg-background/95 shadow-[0_1px_0_var(--border)] backdrop-blur"
      style={{ paddingInlineEnd: scrollbarWidth }}
    >
      {table.getHeaderGroups().map((headerGroup) => (
        <tr
          key={headerGroup.id}
          aria-rowindex={1}
          className={cn(
            "type-technical-label grid bg-muted/20 text-muted-foreground",
            gridClassName
          )}
        >
          {headerGroup.headers.map((header) => (
            <MemoizedDataTableHeaderCell
              key={header.id}
              header={header}
              table={table}
            />
          ))}
        </tr>
      ))}
    </thead>
  )
}

function areDataTableHeadPropsEqual<TData extends RowData>(
  previous: React.ComponentProps<typeof DataTableHead<TData>>,
  next: React.ComponentProps<typeof DataTableHead<TData>>
) {
  return (
    previous.gridClassName === next.gridClassName &&
    previous.scrollbarWidth === next.scrollbarWidth &&
    previous.table.options.columns === next.table.options.columns &&
    previous.table.options.data === next.table.options.data
  )
}

const MemoizedDataTableHead = React.memo(
  DataTableHead,
  areDataTableHeadPropsEqual
) as typeof DataTableHead

function DataTableHeaderCell<TData extends RowData>({
  header,
  table,
}: {
  header: ReturnType<
    DataTableInstance<TData>["getHeaderGroups"]
  >[number]["headers"][number]
  table: DataTableInstance<TData>
}) {
  const canSort = header.column.getCanSort()

  if (!canSort) {
    return <DataTableHeaderCellContent header={header} sortDirection={false} />
  }

  return (
    <Subscribe
      source={table.atoms.sorting}
      selector={() => header.column.getIsSorted()}
    >
      {(sortDirection) => (
        <DataTableHeaderCellContent
          header={header}
          sortDirection={sortDirection}
        />
      )}
    </Subscribe>
  )
}

function areDataTableHeaderCellPropsEqual<TData extends RowData>(
  previous: React.ComponentProps<typeof DataTableHeaderCell<TData>>,
  next: React.ComponentProps<typeof DataTableHeaderCell<TData>>
) {
  if (!previous.header.column.getCanSort()) return false
  return (
    previous.header.id === next.header.id &&
    previous.header.column.columnDef === next.header.column.columnDef &&
    previous.table.store === next.table.store
  )
}

const MemoizedDataTableHeaderCell = React.memo(
  DataTableHeaderCell,
  areDataTableHeaderCellPropsEqual
) as typeof DataTableHeaderCell

function DataTableHeaderCellContent<TData extends RowData>({
  header,
  sortDirection,
}: {
  header: ReturnType<
    DataTableInstance<TData>["getHeaderGroups"]
  >[number]["headers"][number]
  sortDirection: false | "asc" | "desc"
}) {
  const meta = header.column.columnDef.meta
  const canSort = header.column.getCanSort()
  const sortLabel =
    typeof header.column.columnDef.header === "string"
      ? header.column.columnDef.header
      : header.column.id

  return (
    <th
      aria-sort={
        sortDirection === "asc"
          ? "ascending"
          : sortDirection === "desc"
            ? "descending"
            : canSort
              ? "none"
              : undefined
      }
      className={cn(
        "h-10 min-w-0 px-3 text-left font-medium whitespace-nowrap",
        meta?.headerClassName
      )}
      scope="col"
    >
      {header.isPlaceholder ? null : canSort ? (
        <button
          aria-label={`Sort by ${sortLabel}`}
          className="group/sort -mx-2 inline-flex h-full max-w-full items-center gap-1.5 rounded-sm px-2 text-left outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60"
          type="button"
          onClick={header.column.getToggleSortingHandler()}
        >
          <span
            className={cn("truncate uppercase", meta?.headerLabelClassName)}
          >
            <FlexRender header={header} />
          </span>
          <DataTableSortIcon direction={sortDirection} />
        </button>
      ) : (
        <span className="flex h-full items-center uppercase">
          <FlexRender header={header} />
        </span>
      )}
    </th>
  )
}

function DataTableSortIcon({
  direction,
}: {
  direction: false | "asc" | "desc"
}) {
  if (direction === "asc") {
    return <ArrowUp aria-hidden className="size-3 shrink-0 text-foreground" />
  }
  if (direction === "desc") {
    return <ArrowDown aria-hidden className="size-3 shrink-0 text-foreground" />
  }
  return (
    <ArrowUpDown
      aria-hidden
      className="size-3 shrink-0 opacity-45 transition-opacity group-hover/sort:opacity-80"
    />
  )
}

function DataTableBody<TData extends RowData>({
  getRowClassName,
  gridClassName,
  rows,
  scrollElementRef,
}: {
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  gridClassName: string
  rows: Array<Row<typeof dataTableFeatures, TData>>
  scrollElementRef: React.RefObject<HTMLTableSectionElement | null>
}) {
  return (
    <tbody
      ref={scrollElementRef}
      className="block min-h-0 flex-1 overflow-y-auto overscroll-contain border-b border-border/70"
    >
      {rows.map((row) => (
        <DataTableRowSelectionBoundary
          key={row.id}
          canSelect={row.getCanSelect()}
          gridClassName={gridClassName}
          row={row}
          rowClassName={getRowClassName?.(row)}
        />
      ))}
    </tbody>
  )
}

function VirtualDataTableBody<TData extends RowData>({
  getRowClassName,
  gridClassName,
  rows,
  scrollElementRef,
  virtualization,
}: {
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  gridClassName: string
  rows: Array<Row<typeof dataTableFeatures, TData>>
  scrollElementRef: React.RefObject<HTMLTableSectionElement | null>
  virtualization: DataTableVirtualizationOptions
}) {
  const rowVirtualizer = useVirtualizer({
    count: rows.length,
    estimateSize: () => virtualization.estimateRowHeight ?? 72,
    getItemKey: (index) => rows[index]?.id ?? index,
    getScrollElement: () => scrollElementRef.current,
    overscan: virtualization.overscan ?? 6,
  })

  return (
    <tbody
      ref={scrollElementRef}
      className="relative block min-h-0 flex-1 overflow-y-auto overscroll-contain border-b border-border/70"
    >
      <tr
        aria-hidden="true"
        className="pointer-events-none block w-full"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        <td className="block p-0" />
      </tr>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        const row = rows[virtualRow.index]
        if (!row) return null

        return (
          <DataTableRowSelectionBoundary
            key={row.id}
            ref={rowVirtualizer.measureElement}
            ariaRowIndex={virtualRow.index + 2}
            canSelect={row.getCanSelect()}
            dataIndex={virtualRow.index}
            gridClassName={gridClassName}
            row={row}
            rowClassName={getRowClassName?.(row)}
            virtualStart={virtualRow.start}
          />
        )
      })}
    </tbody>
  )
}

interface DataTableRowProps<TData extends RowData> {
  ariaRowIndex?: number
  canSelect: boolean
  dataIndex?: number
  gridClassName: string
  isSelected: boolean
  row: Row<typeof dataTableFeatures, TData>
  rowClassName?: string
  virtualStart?: number
  ref?: React.Ref<HTMLTableRowElement>
}

function DataTableRowSelectionBoundary<TData extends RowData>(
  props: Omit<DataTableRowProps<TData>, "isSelected">
) {
  return (
    <Subscribe
      source={props.row.table.atoms.rowSelection}
      selector={(selection) => Boolean(selection[props.row.id])}
    >
      {(isSelected) => (
        <MemoizedDataTableRow {...props} isSelected={isSelected} />
      )}
    </Subscribe>
  )
}

function DataTableRow<TData extends RowData>({
  ariaRowIndex,
  dataIndex,
  gridClassName,
  isSelected,
  row,
  rowClassName,
  virtualStart,
  ref,
}: DataTableRowProps<TData>) {
  return (
    <tr
      ref={ref}
      aria-rowindex={ariaRowIndex}
      className={cn(
        "grid border-b border-border/70 transition-colors last:border-b-0",
        gridClassName,
        rowClassName
      )}
      data-index={dataIndex}
      data-state={isSelected ? "selected" : undefined}
      style={
        virtualStart === undefined
          ? undefined
          : {
              left: 0,
              position: "absolute",
              top: 0,
              transform: `translateY(${virtualStart}px)`,
              width: "100%",
            }
      }
    >
      {row.getAllCells().map((cell) => (
        <td
          key={cell.id}
          className={cn(
            "flex h-14 min-w-0 items-center px-3",
            cell.column.columnDef.meta?.cellClassName
          )}
        >
          <FlexRender cell={cell} />
        </td>
      ))}
    </tr>
  )
}

function areDataTableRowPropsEqual<TData extends RowData>(
  previous: DataTableRowProps<TData>,
  next: DataTableRowProps<TData>
) {
  return (
    previous.ariaRowIndex === next.ariaRowIndex &&
    previous.canSelect === next.canSelect &&
    previous.dataIndex === next.dataIndex &&
    previous.gridClassName === next.gridClassName &&
    previous.isSelected === next.isSelected &&
    previous.row.id === next.row.id &&
    previous.row.index === next.row.index &&
    previous.row.original === next.row.original &&
    previous.row.table.options.columns === next.row.table.options.columns &&
    previous.rowClassName === next.rowClassName &&
    previous.virtualStart === next.virtualStart
  )
}

const MemoizedDataTableRow = React.memo(
  DataTableRow,
  areDataTableRowPropsEqual
) as typeof DataTableRow

export function DataTableCheckbox({
  ariaLabel,
  checked,
  disabled,
  indeterminate = false,
  onChange,
}: {
  ariaLabel: string
  checked: boolean
  disabled?: boolean
  indeterminate?: boolean
  onChange: React.ChangeEventHandler<HTMLInputElement>
}) {
  const inputRef = React.useRef<HTMLInputElement>(null)

  React.useLayoutEffect(() => {
    if (inputRef.current) inputRef.current.indeterminate = indeterminate
  }, [indeterminate])

  return (
    <input
      ref={inputRef}
      aria-label={ariaLabel}
      checked={checked}
      className="size-4 rounded-[3px] border-input accent-primary"
      disabled={disabled}
      type="checkbox"
      onChange={onChange}
    />
  )
}
