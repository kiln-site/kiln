import * as React from "react"
import { useVirtualizer } from "@tanstack/react-virtual"
import {
  FlexRender,
  Subscribe,
  type Row,
  type RowData,
  type SortingState,
} from "@tanstack/react-table"
import { ArrowDown, ArrowUp, ArrowUpDown, LoaderCircle } from "lucide-react"

import { Button } from "@workspace/ui/components/button"
import { Skeleton } from "@workspace/ui/components/skeleton"
import { cn } from "@workspace/ui/lib/utils"
import {
  dataTableFeatures,
  type DataTableBreakpoint,
  type DataTableDefinition,
  type DataTableInstance,
  type DataTableVirtualizationOptions,
} from "@/lib/data-table"
import type {
  DataTableBodyState,
  DataTablePaginationSource,
  DataTableSource,
} from "@/lib/data-table-source"
import { forkPromise } from "@/effect/promise"

export function DataTableLoadMoreTrigger({
  pagination,
  rowCount,
  scrollRootRef,
}: {
  pagination: DataTablePaginationSource
  rowCount: number
  scrollRootRef: React.RefObject<Element | null>
}) {
  const triggerRef = React.useRef<HTMLDivElement>(null)
  const requestKey = `${pagination.resetKey}:${rowCount}`
  const requestedKeyRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (
      !pagination.hasMore ||
      pagination.state.kind === "loading" ||
      pagination.state.kind === "error"
    ) {
      return
    }
    const target = triggerRef.current
    const scrollRoot = scrollRootRef.current
    if (!target || !scrollRoot) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || requestedKeyRef.current === requestKey) {
          return
        }
        requestedKeyRef.current = requestKey
        forkPromise(() => Promise.resolve(pagination.loadMore()))
      },
      { root: scrollRoot, rootMargin: "320px 0px" }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [pagination, requestKey, scrollRootRef])

  if (!pagination.hasMore && pagination.state.kind === "idle") {
    return null
  }
  return (
    <div ref={triggerRef} className="grid h-12 place-items-center">
      {pagination.state.kind === "error" ? (
        <button
          className="text-xs font-medium text-muted-foreground hover:text-foreground"
          type="button"
          onClick={() => void pagination.loadMore()}
        >
          Loading failed. Try again
        </button>
      ) : (
        <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          Loading more
        </span>
      )}
    </div>
  )
}

export function DataTableCompactList<TItem>({
  emptyState,
  header,
  renderRow,
  scrollRootRef,
  source,
}: {
  emptyState: React.ReactNode
  header?: React.ReactNode
  renderRow: (item: TItem) => React.ReactNode
  scrollRootRef: React.RefObject<Element | null>
  source: DataTableSource<TItem>
}) {
  if (source.body.kind === "loading") {
    return <DataTableLoadingState rowCount={source.body.rowCount} />
  }
  if (source.body.kind === "error") {
    return <DataTableErrorState onRetry={source.body.retry} />
  }
  if (source.rows.length === 0) return emptyState

  return (
    <div
      aria-busy={
        source.refreshing ||
        source.pagination?.state.kind === "loading" ||
        undefined
      }
    >
      {header}
      <div className="divide-y divide-border/70">
        {source.rows.map(renderRow)}
      </div>
      {source.pagination ? (
        <DataTableLoadMoreTrigger
          pagination={source.pagination}
          rowCount={source.rows.length}
          scrollRootRef={scrollRootRef}
        />
      ) : null}
    </div>
  )
}

interface DataTableProps<TData extends RowData> {
  definition: DataTableDefinition<TData>
  emptyState: React.ReactNode
  source: DataTableSource<TData>
  table: DataTableInstance<TData>
}

export function DataTable<TData extends RowData>({
  definition,
  emptyState,
  source,
  table,
}: DataTableProps<TData>) {
  return (
    <Subscribe source={table.atoms.sorting} selector={dataTableSortingResetKey}>
      {(sortingResetKey) => (
        <Subscribe
          source={table.store}
          selector={() => table.getRowModel().rows.map((row) => row.id)}
        >
          {() => (
            <DataTableRowModel
              definition={definition}
              emptyState={emptyState}
              source={source}
              sortingResetKey={sortingResetKey}
              table={table}
            />
          )}
        </Subscribe>
      )}
    </Subscribe>
  )
}

interface DataTableRowModelProps<
  TData extends RowData,
> extends DataTableProps<TData> {
  sortingResetKey: string
}

function DataTableRowModel<TData extends RowData>({
  definition,
  emptyState,
  source,
  sortingResetKey,
  table,
}: DataTableRowModelProps<TData>) {
  const rows = table.getRowModel().rows
  const columnCount = table.getAllLeafColumns().length
  const scrollElementRef = React.useRef<HTMLTableSectionElement>(null)
  const hasBodyState = source.body.kind !== "ready" || rows.length === 0
  const scrollbarWidth = useScrollbarWidth(
    scrollElementRef,
    hasBodyState ? -1 : rows.length
  )
  const bodyState = dataTableBodyState(source.body, emptyState, rows.length)
  const gridStyle = React.useMemo(
    () => dataTableGridStyle(table),
    [table, table.options.columns]
  )

  React.useLayoutEffect(() => {
    const scrollElement = scrollElementRef.current
    if (!scrollElement) return
    scrollElement.scrollTop = 0
    const frame = window.requestAnimationFrame(() => {
      scrollElement.scrollTop = 0
    })
    return () => window.cancelAnimationFrame(frame)
  }, [source.resetKey, sortingResetKey])

  return (
    <div
      aria-busy={
        source.body.kind === "loading" ||
        source.refreshing ||
        source.pagination?.state.kind === "loading" ||
        undefined
      }
      className="relative flex h-full min-h-0 w-full min-w-0 flex-1 flex-col"
    >
      {source.refreshing ? (
        <span
          aria-live="polite"
          className="pointer-events-none absolute top-3 right-3 z-30 inline-flex items-center gap-1.5 text-xs text-muted-foreground"
          role="status"
        >
          <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
          Updating
        </span>
      ) : null}
      {!source.refreshing && source.pagination?.state.kind === "loading" ? (
        <span aria-live="polite" className="sr-only" role="status">
          Loading more rows
        </span>
      ) : null}
      <table
        aria-colcount={columnCount}
        aria-label={definition.ariaLabel}
        aria-rowcount={hasBodyState ? 2 : rows.length + 1}
        className="flex h-full min-h-0 w-full min-w-0 border-collapse flex-col overflow-hidden pb-px text-left"
        style={gridStyle}
      >
        <MemoizedDataTableHead scrollbarWidth={scrollbarWidth} table={table} />
        {hasBodyState ? (
          <DataTableStateBody
            colSpan={columnCount}
            scrollElementRef={scrollElementRef}
          >
            {bodyState}
          </DataTableStateBody>
        ) : definition.virtualization ? (
          <VirtualDataTableBody
            getRowClassName={definition.getRowClassName}
            pagination={source.pagination}
            rows={rows}
            scrollElementRef={scrollElementRef}
            virtualization={definition.virtualization}
          />
        ) : (
          <DataTableBody
            getRowClassName={definition.getRowClassName}
            pagination={source.pagination}
            rows={rows}
            scrollElementRef={scrollElementRef}
          />
        )}
      </table>
    </div>
  )
}

function dataTableSortingResetKey(sorting: SortingState): string {
  return sorting
    .map(({ desc, id }) => `${id}:${desc ? "desc" : "asc"}`)
    .join("|")
}

function dataTableBodyState(
  body: DataTableBodyState,
  emptyState: React.ReactNode,
  rowCount: number
): React.ReactNode {
  if (body.kind === "loading") {
    return <DataTableLoadingState rowCount={body.rowCount} />
  }
  if (body.kind === "error") {
    return <DataTableErrorState onRetry={body.retry} />
  }
  return rowCount === 0 ? emptyState : null
}

const dataTableBreakpoints: ReadonlyArray<DataTableBreakpoint> = [
  "base",
  "sm",
  "md",
  "lg",
  "xl",
]

type DataTableGridStyle = React.CSSProperties &
  Record<`--data-table-grid-${DataTableBreakpoint}`, string>

function dataTableGridStyle<TData extends RowData>(
  table: DataTableInstance<TData>
): DataTableGridStyle {
  const columns = table.getAllLeafColumns()
  const grids = Object.fromEntries(
    dataTableBreakpoints.map((breakpoint) => [
      `--data-table-grid-${breakpoint}`,
      columns
        .filter(
          (column) =>
            !dataTableColumnIsHidden(
              column.columnDef.meta?.layout?.hideBelow,
              breakpoint
            )
        )
        .map((column) =>
          dataTableColumnWidth(column.columnDef.meta?.layout?.width, breakpoint)
        )
        .join(" "),
    ])
  )
  return grids as unknown as DataTableGridStyle
}

function dataTableColumnWidth(
  width: string | Partial<Record<DataTableBreakpoint, string>> | undefined,
  breakpoint: DataTableBreakpoint
): string {
  if (typeof width === "string") return width
  if (!width) return "minmax(0,1fr)"
  const breakpointIndex = dataTableBreakpoints.indexOf(breakpoint)
  for (let index = breakpointIndex; index >= 0; index -= 1) {
    const resolved = width[dataTableBreakpoints[index] ?? "base"]
    if (resolved) return resolved
  }
  return "minmax(0,1fr)"
}

function dataTableColumnIsHidden(
  hideBelow: Exclude<DataTableBreakpoint, "base"> | undefined,
  breakpoint: DataTableBreakpoint
): boolean {
  return Boolean(
    hideBelow &&
    dataTableBreakpoints.indexOf(breakpoint) <
      dataTableBreakpoints.indexOf(hideBelow)
  )
}

function dataTableColumnVisibilityClass(
  hideBelow: Exclude<DataTableBreakpoint, "base"> | undefined,
  element: "cell" | "header"
): string | undefined {
  if (!hideBelow) return undefined
  return dataTableVisibilityClasses[hideBelow][element]
}

const dataTableVisibilityClasses = {
  sm: {
    cell: "hidden sm:flex",
    header: "hidden sm:flex sm:items-center",
  },
  md: {
    cell: "hidden md:flex",
    header: "hidden md:flex md:items-center",
  },
  lg: {
    cell: "hidden lg:flex",
    header: "hidden lg:flex lg:items-center",
  },
  xl: {
    cell: "hidden xl:flex",
    header: "hidden xl:flex xl:items-center",
  },
} as const

function DataTableStateBody({
  children,
  colSpan,
  scrollElementRef,
}: {
  children: React.ReactNode
  colSpan: number
  scrollElementRef: React.RefObject<HTMLTableSectionElement | null>
}) {
  return (
    <tbody
      ref={scrollElementRef}
      className="block min-h-0 flex-1 overflow-y-auto overscroll-contain border-b border-border/70"
    >
      <tr className="block">
        <td className="block p-0" colSpan={colSpan}>
          {children}
        </td>
      </tr>
    </tbody>
  )
}

export function DataTableLoadingState({ rowCount = 7 }: { rowCount?: number }) {
  return (
    <div
      aria-label="Loading table rows"
      className="space-y-2 p-3"
      role="status"
    >
      {Array.from({ length: rowCount }, (_, index) => (
        <Skeleton key={index} className="h-14 w-full" />
      ))}
    </div>
  )
}

export const DataTableTextCell = React.memo(function DataTableTextCell({
  className,
  monospace = false,
  title,
  value,
}: {
  className?: string
  monospace?: boolean
  title?: string
  value: string
}) {
  return (
    <span
      className={cn(
        "type-meta block min-w-0 truncate text-foreground",
        monospace && "font-mono",
        className
      )}
      title={title ?? value}
    >
      {value}
    </span>
  )
})

export function DataTableErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div className="grid h-64 place-items-center px-6 text-center" role="alert">
      <div>
        <p className="text-sm font-semibold">Could not load this table</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Check your connection and try again.
        </p>
        {onRetry ? (
          <Button
            className="mt-4"
            size="sm"
            type="button"
            variant="outline"
            onClick={onRetry}
          >
            Try again
          </Button>
        ) : null}
      </div>
    </div>
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
  scrollbarWidth,
  table,
}: {
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
          className="type-technical-label grid grid-cols-[var(--data-table-grid-base)] bg-muted/20 text-muted-foreground sm:grid-cols-[var(--data-table-grid-sm)] md:grid-cols-[var(--data-table-grid-md)] lg:grid-cols-[var(--data-table-grid-lg)] xl:grid-cols-[var(--data-table-grid-xl)]"
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
    previous.scrollbarWidth === next.scrollbarWidth &&
    previous.table.store === next.table.store &&
    previous.table.options.columns === next.table.options.columns
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
        dataTableColumnVisibilityClass(meta?.layout?.hideBelow, "header"),
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
  pagination,
  rows,
  scrollElementRef,
}: {
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  pagination?: DataTablePaginationSource
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
          row={row}
          rowClassName={getRowClassName?.(row)}
        />
      ))}
      {pagination ? (
        <DataTablePaginationRow
          colSpan={rows[0]?.getAllCells().length ?? 1}
          pagination={pagination}
          rowCount={rows.length}
        />
      ) : null}
    </tbody>
  )
}

function VirtualDataTableBody<TData extends RowData>({
  getRowClassName,
  pagination,
  rows,
  scrollElementRef,
  virtualization,
}: {
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  pagination?: DataTablePaginationSource
  rows: Array<Row<typeof dataTableFeatures, TData>>
  scrollElementRef: React.RefObject<HTMLTableSectionElement | null>
  virtualization: DataTableVirtualizationOptions
}) {
  const showPagination = Boolean(
    pagination?.hasMore || pagination?.state.kind !== "idle"
  )
  const rowVirtualizer = useVirtualizer({
    count: rows.length + (showPagination ? 1 : 0),
    estimateSize: () => virtualization.estimateRowHeight ?? 72,
    getItemKey: (index) => rows[index]?.id ?? `pagination-${index}`,
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
        if (virtualRow.index === rows.length && pagination && showPagination) {
          return (
            <DataTablePaginationRow
              key="pagination"
              ref={rowVirtualizer.measureElement}
              colSpan={rows[0]?.getAllCells().length ?? 1}
              dataIndex={virtualRow.index}
              pagination={pagination}
              rowCount={rows.length}
              virtualStart={virtualRow.start}
            />
          )
        }
        const row = rows[virtualRow.index]
        if (!row) return null

        return (
          <DataTableRowSelectionBoundary
            key={row.id}
            ref={rowVirtualizer.measureElement}
            ariaRowIndex={virtualRow.index + 2}
            canSelect={row.getCanSelect()}
            dataIndex={virtualRow.index}
            row={row}
            rowClassName={getRowClassName?.(row)}
            virtualStart={virtualRow.start}
          />
        )
      })}
    </tbody>
  )
}

function DataTablePaginationRow({
  colSpan,
  dataIndex,
  pagination,
  rowCount,
  virtualStart,
  ref,
}: {
  colSpan: number
  dataIndex?: number
  pagination: DataTablePaginationSource
  rowCount: number
  virtualStart?: number
  ref?: React.Ref<HTMLTableRowElement>
}) {
  const triggerRef = React.useRef<HTMLTableCellElement>(null)
  const requestKey = `${pagination.resetKey}:${rowCount}`
  const requestedKeyRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (
      !pagination.hasMore ||
      pagination.state.kind === "loading" ||
      pagination.state.kind === "error"
    ) {
      return
    }
    const target = triggerRef.current
    if (!target) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting || requestedKeyRef.current === requestKey) {
          return
        }
        requestedKeyRef.current = requestKey
        forkPromise(() => Promise.resolve(pagination.loadMore()))
      },
      { root: target.closest("tbody"), rootMargin: "320px 0px" }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [pagination, requestKey])

  if (!pagination.hasMore && pagination.state.kind === "idle") {
    return null
  }
  return (
    <tr
      ref={ref}
      aria-hidden={pagination.state.kind !== "error"}
      className="grid h-12 place-items-center"
      data-index={dataIndex}
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
      <td ref={triggerRef} className="col-span-full" colSpan={colSpan}>
        {pagination.state.kind === "error" ? (
          <button
            className="text-xs font-medium text-muted-foreground hover:text-foreground"
            type="button"
            onClick={() => void pagination.loadMore()}
          >
            Loading failed. Try again
          </button>
        ) : (
          <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
            <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
            Loading more
          </span>
        )}
      </td>
    </tr>
  )
}

interface DataTableRowProps<TData extends RowData> {
  ariaRowIndex?: number
  canSelect: boolean
  dataIndex?: number
  isSelected: boolean
  row: Row<typeof dataTableFeatures, TData>
  rowClassName?: string
  virtualStart?: number
  ref?: React.Ref<HTMLTableRowElement>
}

function DataTableRowSelectionBoundaryComponent<TData extends RowData>(
  props: Omit<DataTableRowProps<TData>, "isSelected">
) {
  if (!props.canSelect) {
    return <MemoizedDataTableRow {...props} isSelected={false} />
  }
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

function areDataTableRowBoundaryPropsEqual<TData extends RowData>(
  previous: Omit<DataTableRowProps<TData>, "isSelected">,
  next: Omit<DataTableRowProps<TData>, "isSelected">
) {
  return (
    previous.ariaRowIndex === next.ariaRowIndex &&
    previous.canSelect === next.canSelect &&
    previous.dataIndex === next.dataIndex &&
    previous.ref === next.ref &&
    previous.row.id === next.row.id &&
    previous.row.index === next.row.index &&
    previous.row.original === next.row.original &&
    previous.row.table.options.columns === next.row.table.options.columns &&
    previous.rowClassName === next.rowClassName &&
    previous.virtualStart === next.virtualStart
  )
}

const DataTableRowSelectionBoundary = React.memo(
  DataTableRowSelectionBoundaryComponent,
  areDataTableRowBoundaryPropsEqual
) as typeof DataTableRowSelectionBoundaryComponent

function DataTableRow<TData extends RowData>({
  ariaRowIndex,
  dataIndex,
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
        "grid grid-cols-[var(--data-table-grid-base)] border-b border-border/70 transition-colors last:border-b-0 sm:grid-cols-[var(--data-table-grid-sm)] md:grid-cols-[var(--data-table-grid-md)] lg:grid-cols-[var(--data-table-grid-lg)] xl:grid-cols-[var(--data-table-grid-xl)]",
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
            dataTableColumnVisibilityClass(
              cell.column.columnDef.meta?.layout?.hideBelow,
              "cell"
            ),
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
    previous.isSelected === next.isSelected &&
    previous.ref === next.ref &&
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
  id,
  indeterminate = false,
  onChange,
}: {
  ariaLabel: string
  checked: boolean
  disabled?: boolean
  id?: string
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
      id={id}
      type="checkbox"
      onChange={onChange}
    />
  )
}

type DataTableSelectAllState =
  | "checked"
  | "disabled"
  | "indeterminate"
  | "unchecked"

export function DataTableSelectAllCheckbox<TData extends RowData>({
  ariaLabel,
  className = "grid size-7 place-items-center",
  id,
  table,
}: {
  ariaLabel: string
  className?: string
  id?: string
  table: DataTableInstance<TData>
}) {
  return (
    <Subscribe
      source={table.store}
      selector={() => getDataTableSelectAllState(table)}
    >
      {(state) => (
        <span className={className}>
          <DataTableCheckbox
            ariaLabel={ariaLabel}
            checked={state === "checked"}
            disabled={state === "disabled"}
            id={id}
            indeterminate={state === "indeterminate"}
            onChange={table.getToggleAllRowsSelectedHandler()}
          />
        </span>
      )}
    </Subscribe>
  )
}

function getDataTableSelectAllState<TData extends RowData>(
  table: DataTableInstance<TData>
): DataTableSelectAllState {
  const selectableRows = table
    .getRowModel()
    .rows.filter((row) => row.getCanSelect())
  if (selectableRows.length === 0) return "disabled"

  const selectedCount = selectableRows.reduce(
    (count, row) => count + Number(row.getIsSelected()),
    0
  )
  if (selectedCount === 0) return "unchecked"
  if (selectedCount === selectableRows.length) return "checked"
  return "indeterminate"
}

export function DataTableRowCheckbox<TData extends RowData>({
  ariaLabel,
  className = "grid size-7 shrink-0 place-items-center",
  disabledTitle,
  row,
}: {
  ariaLabel: string
  className?: string
  disabledTitle?: string
  row: Row<typeof dataTableFeatures, TData>
}) {
  const disabled = !row.getCanSelect()

  return (
    <span className={className} title={disabled ? disabledTitle : undefined}>
      <Subscribe
        source={row.table.atoms.rowSelection}
        selector={() => row.getIsSelected()}
      >
        {(selected) => (
          <DataTableCheckbox
            ariaLabel={ariaLabel}
            checked={selected}
            disabled={disabled}
            onChange={row.getToggleSelectedHandler()}
          />
        )}
      </Subscribe>
    </span>
  )
}
