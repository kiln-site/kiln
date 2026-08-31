import * as React from "react"
import type { InfiniteData } from "@tanstack/react-query"

import { flattenCursorPages, type CursorPage } from "@/lib/cursor-page"

export type DataTableBodyState =
  | { kind: "error"; error: Error; retry?: () => void }
  | { kind: "loading"; rowCount?: number }
  | { kind: "ready" }

export type DataTableLoadMoreState =
  | { kind: "error"; error: Error }
  | { kind: "idle" }
  | { kind: "loading" }

export interface DataTableNotice {
  kind: "stale"
  retry?: () => void
}

export interface DataTableLoadMoreSource {
  hasMore: boolean
  loadMore: () => Promise<unknown> | void
  requestKey: string
  state: DataTableLoadMoreState
}

export interface DataTableSource<TItem> {
  body: DataTableBodyState
  loadMore?: DataTableLoadMoreSource
  notice?: DataTableNotice
  refreshing: boolean
  resetKey?: string
  rows: Array<TItem>
}

export function shouldRenderDataTableLoadMore(
  loadMore: DataTableLoadMoreSource | undefined
): boolean {
  return Boolean(
    loadMore && (loadMore.hasMore || loadMore.state.kind !== "idle")
  )
}

interface CursorDataTableStateInput {
  error: Error | null
  hasData: boolean
  isError: boolean
  isFetchNextPageError: boolean
  isPending: boolean
  retry: () => void
}

interface LiveDataTableStateInput {
  error: Error
  isError: boolean
  isLoading: boolean
  retry?: () => void
  rowCount: number
}

interface CursorDataTableLoadMoreStateInput {
  error: Error | null
  isFetchNextPageError: boolean
  isFetchingNextPage: boolean
  refreshing: boolean
}

interface CursorQueryResult<TItem, TCursor> {
  data?: InfiniteData<CursorPage<TItem, TCursor>, TCursor>
  error: Error | null
  fetchNextPage: () => Promise<unknown>
  hasNextPage: boolean
  isError: boolean
  isFetching: boolean
  isFetchingNextPage: boolean
  isFetchNextPageError: boolean
  isPending: boolean
  isPlaceholderData: boolean
  refetch: () => Promise<unknown>
}

export function useCursorDataTableSource<TItem, TCursor>({
  getRowKey,
  query,
  resetKey,
}: {
  getRowKey: (item: TItem) => string
  query: CursorQueryResult<TItem, TCursor>
  resetKey: string
}): DataTableSource<TItem> {
  const {
    data,
    error,
    fetchNextPage,
    hasNextPage,
    isError,
    isFetching,
    isFetchingNextPage,
    isFetchNextPageError,
    isPending,
    isPlaceholderData,
    refetch,
  } = query
  const refreshing = isPlaceholderData && isFetching
  const pageCount = data?.pages.length ?? 0
  const rows = React.useMemo(
    () => (data ? flattenCursorPages(data.pages, getRowKey) : []),
    [data, getRowKey]
  )
  const retry = React.useCallback(() => {
    void refetch()
  }, [refetch])
  const loadMore = React.useCallback(() => fetchNextPage(), [fetchNextPage])
  const body = React.useMemo(
    () =>
      resolveCursorDataTableBodyState({
        error,
        hasData: Boolean(data),
        isError,
        isFetchNextPageError,
        isPending,
        retry,
      }),
    [data, error, isError, isFetchNextPageError, isPending, retry]
  )
  const loadMoreSource = React.useMemo<DataTableLoadMoreSource>(
    () => ({
      hasMore: !refreshing && hasNextPage,
      loadMore,
      requestKey: `${resetKey}:${pageCount}`,
      state: resolveCursorDataTableLoadMoreState({
        error,
        isFetchNextPageError,
        isFetchingNextPage,
        refreshing,
      }),
    }),
    [
      error,
      hasNextPage,
      isFetchingNextPage,
      isFetchNextPageError,
      loadMore,
      pageCount,
      refreshing,
      resetKey,
    ]
  )
  const notice = React.useMemo<DataTableNotice | undefined>(
    () =>
      isError && Boolean(data) && !isFetchNextPageError
        ? { kind: "stale", retry }
        : undefined,
    [data, isError, isFetchNextPageError, retry]
  )

  return React.useMemo(
    () => ({
      body,
      loadMore: loadMoreSource,
      notice,
      refreshing,
      resetKey,
      rows,
    }),
    [body, loadMoreSource, notice, refreshing, resetKey, rows]
  )
}

export function useLiveDataTableSource<TItem>({
  data,
  error,
  isError,
  isLoading,
  refreshing = false,
  retry,
}: {
  data: Array<TItem> | undefined
  error: Error
  isError: boolean
  isLoading: boolean
  refreshing?: boolean
  retry?: () => void
}): DataTableSource<TItem> {
  const rows = data ?? emptyRows<TItem>()
  const body = React.useMemo(
    () =>
      resolveLiveDataTableBodyState({
        error,
        isError,
        isLoading,
        retry,
        rowCount: rows.length,
      }),
    [error, isError, isLoading, retry, rows.length]
  )
  const notice = React.useMemo<DataTableNotice | undefined>(
    () => (isError && rows.length > 0 ? { kind: "stale", retry } : undefined),
    [isError, retry, rows.length]
  )

  return React.useMemo(
    () => ({ body, notice, refreshing, rows }),
    [body, notice, refreshing, rows]
  )
}

export function replaceDataTableRows<TSourceItem, TNextItem>(
  source: DataTableSource<TSourceItem>,
  rows: Array<TNextItem>
): DataTableSource<TNextItem> {
  return { ...source, rows }
}

export function resolveCursorDataTableBodyState({
  error,
  hasData,
  isError,
  isFetchNextPageError,
  isPending,
  retry,
}: CursorDataTableStateInput): DataTableBodyState {
  if (isPending && !hasData) return { kind: "loading" }
  if (isError && !hasData && !isFetchNextPageError && error) {
    return { error, kind: "error", retry }
  }
  return { kind: "ready" }
}

export function resolveLiveDataTableBodyState({
  error,
  isError,
  isLoading,
  retry,
  rowCount,
}: LiveDataTableStateInput): DataTableBodyState {
  if (rowCount > 0) return { kind: "ready" }
  if (isLoading) return { kind: "loading" }
  if (isError) return { error, kind: "error", retry }
  return { kind: "ready" }
}

export function resolveCursorDataTableLoadMoreState({
  error,
  isFetchNextPageError,
  isFetchingNextPage,
  refreshing,
}: CursorDataTableLoadMoreStateInput): DataTableLoadMoreState {
  if (refreshing) return { kind: "idle" }
  if (isFetchNextPageError && error) return { error, kind: "error" }
  if (isFetchingNextPage) return { kind: "loading" }
  return { kind: "idle" }
}

const sharedEmptyRows: Array<never> = []

function emptyRows<TItem>(): Array<TItem> {
  return sharedEmptyRows
}
