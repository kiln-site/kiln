import * as React from "react"

import {
  createDataTableSearchStore,
  useDataTableSearchInput,
  type DataTableSearchStore,
} from "@/lib/data-table-search"

export type WorkspaceTableSearchStore = DataTableSearchStore

interface WorkspaceDataTableProps<T> {
  getRowKey: (item: T) => React.Key
  getSearchText: (item: T) => string
  head: React.ReactNode
  items: Array<T>
  renderEmpty: (searchActive: boolean) => React.ReactNode
  renderRow: (item: T) => React.ReactNode
  searchStore: WorkspaceTableSearchStore
}

interface SearchableItem<T> {
  item: T
  searchText: string
}

export function createWorkspaceTableSearchStore(
  initialValue = ""
): WorkspaceTableSearchStore {
  return createDataTableSearchStore(initialValue)
}

export function useWorkspaceTableSearchInput(
  inputRef: React.RefObject<HTMLInputElement | null>,
  store: WorkspaceTableSearchStore
) {
  useDataTableSearchInput(inputRef, store)
}

export function WorkspaceDataTable<T>({
  getRowKey,
  getSearchText,
  head,
  items,
  renderEmpty,
  renderRow,
  searchStore,
}: WorkspaceDataTableProps<T>) {
  const searchableItems = React.useMemo(
    () =>
      items.map((item) => ({
        item,
        searchText: getSearchText(item).toLowerCase(),
      })),
    [getSearchText, items]
  )
  const getHasMatchesSnapshot = React.useCallback(
    () => hasMatchingItem(searchableItems, searchStore.getNormalizedSnapshot()),
    [searchStore, searchableItems]
  )
  const getHasMatchesServerSnapshot = React.useCallback(
    () =>
      hasMatchingItem(
        searchableItems,
        searchStore.getNormalizedServerSnapshot()
      ),
    [searchStore, searchableItems]
  )
  const hasMatches = React.useSyncExternalStore(
    searchStore.subscribe,
    getHasMatchesSnapshot,
    getHasMatchesServerSnapshot
  )

  if (!hasMatches) {
    return renderEmpty(searchStore.getNormalizedSnapshot().length > 0)
  }

  return (
    <div className="min-w-0 overflow-clip pb-px">
      <table className="w-full table-fixed border-collapse text-left">
        {head}
        <tbody className="divide-y divide-border/70 border-b border-border/70">
          {searchableItems.map(({ item, searchText }) => (
            <SearchableWorkspaceTableRow
              key={getRowKey(item)}
              item={item}
              renderRow={renderRow}
              searchStore={searchStore}
              searchText={searchText}
            />
          ))}
        </tbody>
      </table>
    </div>
  )
}

interface SearchableWorkspaceTableRowProps<T> {
  item: T
  renderRow: (item: T) => React.ReactNode
  searchStore: WorkspaceTableSearchStore
  searchText: string
}

const SearchableWorkspaceTableRow = React.memo(
  function SearchableWorkspaceTableRow<T>({
    item,
    renderRow,
    searchStore,
    searchText,
  }: SearchableWorkspaceTableRowProps<T>) {
    const getMatchesSnapshot = React.useCallback(
      () => matchesSearch(searchText, searchStore.getNormalizedSnapshot()),
      [searchStore, searchText]
    )
    const getMatchesServerSnapshot = React.useCallback(
      () =>
        matchesSearch(searchText, searchStore.getNormalizedServerSnapshot()),
      [searchStore, searchText]
    )
    const matches = React.useSyncExternalStore(
      searchStore.subscribe,
      getMatchesSnapshot,
      getMatchesServerSnapshot
    )

    if (!matches) return null
    return renderRow(item)
  }
) as <T>(props: SearchableWorkspaceTableRowProps<T>) => React.ReactNode

export const WorkspaceTableHead = React.memo(function WorkspaceTableHead({
  className = "",
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <thead className={className}>
      <tr className="type-technical-label border-b bg-muted/20 text-muted-foreground">
        {children}
      </tr>
    </thead>
  )
})

export function WorkspaceTableHeading({
  className = "",
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <th
      className={`h-10 px-3 text-left font-medium whitespace-nowrap ${className}`}
    >
      {children}
    </th>
  )
}

export function WorkspaceTableCell({
  className = "",
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return <td className={`h-14 px-3 align-middle ${className}`}>{children}</td>
}

function matchesSearch(searchText: string, normalizedSearch: string): boolean {
  return normalizedSearch.length === 0 || searchText.includes(normalizedSearch)
}

function hasMatchingItem<T>(
  items: Array<SearchableItem<T>>,
  normalizedSearch: string
): boolean {
  return items.some((item) => matchesSearch(item.searchText, normalizedSearch))
}
