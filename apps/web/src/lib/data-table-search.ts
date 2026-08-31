import * as React from "react"

import type {
  DataTableSearchDefinition,
  DataTableSearchValue,
} from "@/lib/data-table"

export interface DataTableSearchStore {
  getNormalizedServerSnapshot: () => string
  getNormalizedSnapshot: () => string
  getServerSnapshot: () => string
  getSnapshot: () => string
  set: (value: string) => void
  subscribe: (listener: () => void) => () => void
}

export const DATA_TABLE_SEARCH_MAX_LENGTH = 256

export function createDataTableSearchStore(
  initialValue = ""
): DataTableSearchStore {
  let value = initialValue
  let normalizedValue = normalizeDataTableSearch(initialValue)
  const serverValue = initialValue
  const normalizedServerValue = normalizedValue
  const listeners = new Set<() => void>()

  return {
    getNormalizedServerSnapshot: () => normalizedServerValue,
    getNormalizedSnapshot: () => normalizedValue,
    getServerSnapshot: () => serverValue,
    getSnapshot: () => value,
    set: (nextValue) => {
      if (nextValue === value) return
      value = nextValue
      normalizedValue = normalizeDataTableSearch(nextValue)
      for (const listener of listeners) listener()
    },
    subscribe: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
  }
}

export function useDataTableSearchStore(value: string): DataTableSearchStore {
  const [store] = React.useState(() => createDataTableSearchStore(value))

  React.useLayoutEffect(() => {
    store.set(value)
  }, [store, value])

  return store
}

export function replaceDataTableUrlSearch(
  value: string,
  parameter = "search"
): void {
  const url = new URL(window.location.href)
  if (value.length > 0) url.searchParams.set(parameter, value)
  else url.searchParams.delete(parameter)

  // TanStack patches the history instance methods so router consumers update
  // after navigation. Search typing stays local to the table workspace to avoid
  // repainting the router's SafeFragment and CatchBoundary tree per keystroke.
  History.prototype.replaceState.call(
    window.history,
    window.history.state,
    "",
    `${url.pathname}${url.search}${url.hash}`
  )
}

export function useDataTableSearchInput(
  inputRef: React.RefObject<HTMLInputElement | null>,
  store: DataTableSearchStore
) {
  React.useLayoutEffect(
    () =>
      store.subscribe(() => {
        const input = inputRef.current
        const search = store.getSnapshot()
        if (input && input.value !== search) input.value = search
      }),
    [inputRef, store]
  )
}

export function filterDataTableRows<TData extends object>(
  rows: Array<TData>,
  search: string,
  definition: DataTableSearchDefinition<TData>,
  cache: WeakMap<TData, string>
): Array<TData> {
  if (search.length === 0) return rows
  return rows.filter((row) =>
    getDataTableSearchText(row, definition, cache).includes(search)
  )
}

export function normalizeDataTableSearch(search: string): string {
  return search.trim().toLowerCase()
}

function getDataTableSearchText<TData extends object>(
  row: TData,
  definition: DataTableSearchDefinition<TData>,
  cache: WeakMap<TData, string>
): string {
  const cached = cache.get(row)
  if (cached !== undefined) return cached
  let searchText = ""
  for (const field of definition.fields) {
    const value = normalizeDataTableSearchValue(field(row))
    if (value.length === 0) continue
    searchText += `${searchText.length === 0 ? "" : " "}${value}`
  }
  cache.set(row, searchText)
  return searchText
}

function normalizeDataTableSearchValue(value: DataTableSearchValue): string {
  return value === null || value === undefined
    ? ""
    : normalizeDataTableSearch(String(value))
}
