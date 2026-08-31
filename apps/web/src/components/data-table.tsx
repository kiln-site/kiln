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
  defaultDataTableVirtualization,
  type DataTableBreakpoint,
  type DataTableDefinition,
  type DataTableInstance,
  type DataTableVirtualizationOptions,
} from "@/lib/data-table"
import {
  type DataTableBodyState,
  type DataTableLoadMoreSource,
  type DataTableSource,
  shouldRenderDataTableLoadMore,
} from "@/lib/data-table-source"
import { forkPromise } from "@/effect/promise"

export function DataTableLoadMoreTrigger({
  loadMoreSource,
  scrollRootRef,
}: {
  loadMoreSource: DataTableLoadMoreSource
  scrollRootRef: React.RefObject<Element | null>
}) {
  const triggerRef = useDataTableLoadMoreTrigger<HTMLDivElement>(
    loadMoreSource,
    scrollRootRef
  )

  if (!loadMoreSource.hasMore && loadMoreSource.state.kind === "idle") {
    return null
  }
  return (
    <div ref={triggerRef} className="grid h-12 place-items-center">
      <DataTableLoadMoreContent source={loadMoreSource} />
    </div>
  )
}

function useDataTableLoadMoreTrigger<TElement extends Element>(
  source: DataTableLoadMoreSource,
  scrollRootRef?: React.RefObject<Element | null>
): React.RefObject<TElement | null> {
  const triggerRef = React.useRef<TElement>(null)
  const requestedKeyRef = React.useRef<string | null>(null)

  React.useEffect(() => {
    if (
      !source.hasMore ||
      source.state.kind === "loading" ||
      source.state.kind === "error"
    ) {
      return
    }
    const target = triggerRef.current
    const scrollRoot = scrollRootRef?.current ?? target?.closest("tbody")
    if (!target || !scrollRoot) return
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (
          !entry?.isIntersecting ||
          requestedKeyRef.current === source.requestKey
        ) {
          return
        }
        requestedKeyRef.current = source.requestKey
        forkPromise(() => Promise.resolve(source.loadMore()))
      },
      { root: scrollRoot, rootMargin: "320px 0px" }
    )
    observer.observe(target)
    return () => observer.disconnect()
  }, [scrollRootRef, source])

  return triggerRef
}

function DataTableLoadMoreContent({
  source,
}: {
  source: DataTableLoadMoreSource
}) {
  return source.state.kind === "error" ? (
    <button
      className="text-xs font-medium text-muted-foreground hover:text-foreground"
      type="button"
      onClick={() => void source.loadMore()}
    >
      Loading failed. Try again
    </button>
  ) : (
    <span className="inline-flex items-center gap-2 text-xs text-muted-foreground">
      <LoaderCircle aria-hidden className="size-3.5 animate-spin" />
      Loading more
    </span>
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
    return (
      <DataTableCenteredState>
        <DataTableErrorState onRetry={source.body.retry} />
      </DataTableCenteredState>
    )
  }
  if (source.rows.length === 0) {
    return <DataTableCenteredState>{emptyState}</DataTableCenteredState>
  }

  return (
    <div
      aria-busy={
        source.refreshing ||
        source.loadMore?.state.kind === "loading" ||
        undefined
      }
    >
      {source.notice ? <DataTableSourceNotice notice={source.notice} /> : null}
      {header}
      <div className="divide-y divide-border/70 border-b border-border/70">
        {source.rows.map(renderRow)}
      </div>
      {source.loadMore && shouldRenderDataTableLoadMore(source.loadMore) ? (
        <DataTableLoadMoreTrigger
          loadMoreSource={source.loadMore}
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

const dataTableScrollAreaClassName =
  "block min-h-0 flex-1 overflow-x-hidden overflow-y-auto overscroll-y-contain border-b border-border/70"

export function DataTableRenderer<TData extends RowData>({
  definition,
  emptyState,
  source,
  table,
}: DataTableProps<TData>) {
  return (
    <Subscribe source={table.atoms.sorting} selector={dataTableSortingResetKey}>
      {(sortingResetKey) => (
        <DataTableRowModel
          definition={definition}
          emptyState={emptyState}
          source={source}
          sortingResetKey={sortingResetKey}
          table={table}
        />
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
    [table, definition.columns]
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
        source.loadMore?.state.kind === "loading" ||
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
      {!source.refreshing && source.notice ? (
        <DataTableSourceNotice floating notice={source.notice} />
      ) : null}
      {!source.refreshing && source.loadMore?.state.kind === "loading" ? (
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
        <MemoizedDataTableHead
          columns={definition.columns}
          scrollbarWidth={scrollbarWidth}
          table={table}
        />
        {hasBodyState ? (
          <DataTableStateBody
            centered={source.body.kind !== "loading"}
            colSpan={columnCount}
            scrollElementRef={scrollElementRef}
          >
            {bodyState}
          </DataTableStateBody>
        ) : definition.virtualization ? (
          <VirtualDataTableBody
            columns={definition.columns}
            getRowClassName={definition.getRowClassName}
            loadMoreSource={source.loadMore}
            rows={rows}
            scrollElementRef={scrollElementRef}
            virtualization={definition.virtualization}
          />
        ) : (
          <DataTableBody
            columns={definition.columns}
            getRowClassName={definition.getRowClassName}
            loadMoreSource={source.loadMore}
            rows={rows}
            scrollElementRef={scrollElementRef}
          />
        )}
      </table>
    </div>
  )
}

function DataTableSourceNotice({
  floating = false,
  notice,
}: {
  floating?: boolean
  notice: NonNullable<DataTableSource<unknown>["notice"]>
}) {
  return (
    <div
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-1.5 text-xs text-amber-700 dark:text-amber-300",
        floating
          ? "absolute top-3 right-3 z-30 rounded-md border border-amber-500/25 bg-background/95 px-2 py-1 shadow-sm"
          : "flex min-h-9 justify-end border-b border-amber-500/20 bg-amber-500/[0.06] px-3 py-2"
      )}
      role="status"
    >
      Data may be outdated.
      {notice.retry ? (
        <button
          className="font-medium underline-offset-2 hover:underline"
          type="button"
          onClick={notice.retry}
        >
          Retry
        </button>
      ) : null}
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
  centered,
  children,
  colSpan,
  scrollElementRef,
}: {
  centered: boolean
  children: React.ReactNode
  colSpan: number
  scrollElementRef: React.RefObject<HTMLTableSectionElement | null>
}) {
  return (
    <tbody ref={scrollElementRef} className={dataTableScrollAreaClassName}>
      <tr className={cn("block", centered && "h-full")}>
        <td className={cn("block p-0", centered && "h-full")} colSpan={colSpan}>
          {centered ? (
            <DataTableCenteredState>{children}</DataTableCenteredState>
          ) : (
            children
          )}
        </td>
      </tr>
    </tbody>
  )
}

function DataTableCenteredState({ children }: { children: React.ReactNode }) {
  return <div className="grid h-full place-items-center">{children}</div>
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

export function DataTableActionGroup({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <div
      className={cn("flex w-full items-center justify-end gap-1", className)}
    >
      {children}
    </div>
  )
}

export function DataTableEmptyState({
  action,
  description,
  icon,
  title,
}: {
  action?: React.ReactNode
  description: React.ReactNode
  icon?: React.ReactNode
  title: React.ReactNode
}) {
  return (
    <div className="px-6 py-12 text-center">
      {icon ? <div className="flex justify-center">{icon}</div> : null}
      <p className="mt-3 text-sm font-semibold">{title}</p>
      <div className="type-support mt-1 text-muted-foreground">
        {description}
      </div>
      {action ? <div className="mt-4 flex justify-center">{action}</div> : null}
    </div>
  )
}

export function DataTableErrorState({ onRetry }: { onRetry?: () => void }) {
  return (
    <div role="alert">
      <DataTableEmptyState
        action={
          onRetry ? (
            <Button size="sm" type="button" variant="outline" onClick={onRetry}>
              Try again
            </Button>
          ) : null
        }
        description="Check your connection and try again."
        title="Could not load this table"
      />
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
  columns: _columns,
  scrollbarWidth,
  table,
}: {
  columns: DataTableDefinition<TData>["columns"]
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
    previous.columns === next.columns &&
    previous.scrollbarWidth === next.scrollbarWidth &&
    previous.table.store === next.table.store
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
  columns,
  getRowClassName,
  loadMoreSource,
  rows,
  scrollElementRef,
}: {
  columns: DataTableDefinition<TData>["columns"]
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  loadMoreSource?: DataTableLoadMoreSource
  rows: Array<Row<typeof dataTableFeatures, TData>>
  scrollElementRef: React.RefObject<HTMLTableSectionElement | null>
}) {
  const showLoadMoreRow = shouldRenderDataTableLoadMore(loadMoreSource)

  return (
    <tbody ref={scrollElementRef} className={dataTableScrollAreaClassName}>
      {rows.map((row) => (
        <DataTableRowSelectionBoundary
          key={row.id}
          canSelect={row.getCanSelect()}
          columns={columns}
          row={row}
          rowClassName={getRowClassName?.(row)}
        />
      ))}
      {loadMoreSource && showLoadMoreRow ? (
        <DataTableLoadMoreRow
          colSpan={rows[0]?.getAllCells().length ?? 1}
          loadMoreSource={loadMoreSource}
        />
      ) : null}
    </tbody>
  )
}

function VirtualDataTableBody<TData extends RowData>({
  columns,
  getRowClassName,
  loadMoreSource,
  rows,
  scrollElementRef,
  virtualization,
}: {
  columns: DataTableDefinition<TData>["columns"]
  getRowClassName?: (row: Row<typeof dataTableFeatures, TData>) => string
  loadMoreSource?: DataTableLoadMoreSource
  rows: Array<Row<typeof dataTableFeatures, TData>>
  scrollElementRef: React.RefObject<HTMLTableSectionElement | null>
  virtualization: true | DataTableVirtualizationOptions
}) {
  const showLoadMoreRow = shouldRenderDataTableLoadMore(loadMoreSource)
  const virtualizationOptions =
    virtualization === true ? defaultDataTableVirtualization : virtualization
  const rowVirtualizer = useVirtualizer({
    count: rows.length + (showLoadMoreRow ? 1 : 0),
    estimateSize: () =>
      virtualizationOptions.estimateRowHeight ??
      defaultDataTableVirtualization.estimateRowHeight,
    getItemKey: (index) => rows[index]?.id ?? `load-more-${index}`,
    getScrollElement: () => scrollElementRef.current,
    overscan:
      virtualizationOptions.overscan ?? defaultDataTableVirtualization.overscan,
  })

  return (
    <tbody
      ref={scrollElementRef}
      className={cn("relative", dataTableScrollAreaClassName)}
    >
      <tr
        aria-hidden="true"
        className="pointer-events-none block w-full"
        style={{ height: rowVirtualizer.getTotalSize() }}
      >
        <td className="block p-0" />
      </tr>
      {rowVirtualizer.getVirtualItems().map((virtualRow) => {
        if (
          virtualRow.index === rows.length &&
          loadMoreSource &&
          showLoadMoreRow
        ) {
          return (
            <DataTableLoadMoreRow
              key="load-more"
              ref={rowVirtualizer.measureElement}
              colSpan={rows[0]?.getAllCells().length ?? 1}
              dataIndex={virtualRow.index}
              loadMoreSource={loadMoreSource}
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
            columns={columns}
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

function DataTableLoadMoreRow({
  colSpan,
  dataIndex,
  loadMoreSource,
  virtualStart,
  ref,
}: {
  colSpan: number
  dataIndex?: number
  loadMoreSource: DataTableLoadMoreSource
  virtualStart?: number
  ref?: React.Ref<HTMLTableRowElement>
}) {
  const triggerRef =
    useDataTableLoadMoreTrigger<HTMLTableCellElement>(loadMoreSource)

  if (!loadMoreSource.hasMore && loadMoreSource.state.kind === "idle") {
    return null
  }
  return (
    <tr
      ref={ref}
      aria-hidden={loadMoreSource.state.kind !== "error"}
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
        <DataTableLoadMoreContent source={loadMoreSource} />
      </td>
    </tr>
  )
}

interface DataTableRowProps<TData extends RowData> {
  ariaRowIndex?: number
  canSelect: boolean
  columns: DataTableDefinition<TData>["columns"]
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
    previous.columns === next.columns &&
    previous.dataIndex === next.dataIndex &&
    previous.ref === next.ref &&
    previous.row.id === next.row.id &&
    previous.row.index === next.row.index &&
    previous.row.original === next.row.original &&
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
  columns: _columns,
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
        "group grid grid-cols-[var(--data-table-grid-base)] border-b border-border/70 transition-colors hover:bg-muted/20 sm:grid-cols-[var(--data-table-grid-sm)] md:grid-cols-[var(--data-table-grid-md)] lg:grid-cols-[var(--data-table-grid-lg)] xl:grid-cols-[var(--data-table-grid-xl)]",
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
    previous.columns === next.columns &&
    previous.dataIndex === next.dataIndex &&
    previous.isSelected === next.isSelected &&
    previous.ref === next.ref &&
    previous.row.id === next.row.id &&
    previous.row.index === next.row.index &&
    previous.row.original === next.row.original &&
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
