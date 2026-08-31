import * as React from "react"
import type { RowData } from "@tanstack/react-table"

import { DataTable } from "@/components/data-table"
import {
  type DataTableDefinition,
  type DataTableInstance,
  useDataTable,
} from "@/lib/data-table"
import {
  filterDataTableRows,
  type DataTableSearchStore,
} from "@/lib/data-table-search"
import {
  replaceDataTableRows,
  type DataTableSource,
} from "@/lib/data-table-source"

interface DataTableViewContext {
  searchActive: boolean
}

interface DataTableViewProps<TData extends RowData & object> {
  children?: (table: DataTableInstance<TData>) => React.ReactNode
  definition: DataTableDefinition<TData>
  emptyState:
    | React.ReactNode
    | ((context: DataTableViewContext) => React.ReactNode)
  searchStore?: DataTableSearchStore
  source: DataTableSource<TData>
}

export function DataTableView<TData extends RowData & object>(
  props: DataTableViewProps<TData>
) {
  if (props.definition.search && props.searchStore) {
    return (
      <SearchableDataTableView {...props} searchStore={props.searchStore} />
    )
  }
  return <DataTableModel {...props} searchActive={false} />
}

function SearchableDataTableView<TData extends RowData & object>({
  definition,
  searchStore,
  source,
  ...props
}: DataTableViewProps<TData> & { searchStore: DataTableSearchStore }) {
  const search = React.useSyncExternalStore(
    searchStore.subscribe,
    searchStore.getNormalizedSnapshot,
    searchStore.getNormalizedServerSnapshot
  )
  const cache = React.useMemo(
    () => new WeakMap<TData, string>(),
    [definition.search]
  )
  const rows = React.useMemo(
    () =>
      definition.search
        ? filterDataTableRows(source.rows, search, definition.search, cache)
        : source.rows,
    [cache, definition.search, search, source.rows]
  )
  const filteredSource = React.useMemo(
    () => ({
      ...replaceDataTableRows(source, rows),
      resetKey: source.resetKey ? `${source.resetKey}:${search}` : search,
    }),
    [rows, search, source]
  )

  return (
    <DataTableModel
      {...props}
      definition={definition}
      searchActive={search.length > 0}
      source={filteredSource}
    />
  )
}

function DataTableModel<TData extends RowData & object>({
  children,
  definition,
  emptyState,
  searchActive,
  source,
}: Omit<DataTableViewProps<TData>, "searchStore"> & {
  searchActive: boolean
}) {
  const table = useDataTable({
    ...definition.model,
    columns: definition.columns,
    data: source.rows,
  })
  const resolvedEmptyState =
    typeof emptyState === "function" ? emptyState({ searchActive }) : emptyState

  return (
    <>
      {children?.(table)}
      <DataTable
        definition={definition}
        emptyState={resolvedEmptyState}
        source={source}
        table={table}
      />
    </>
  )
}
