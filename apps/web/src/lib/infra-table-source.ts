import * as React from "react"
import { useQueries, type UseQueryResult } from "@tanstack/react-query"
import type {
  InstanceReference,
  InstanceInventory,
  InstanceInventoryView,
} from "@workspace/contracts"

import {
  useLiveDataTableSource,
  type DataTableSource,
} from "@/lib/data-table-source"
import {
  instanceStateFromQuery,
  type InstanceState,
} from "@/lib/instance-state"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"

export type InfraInstanceRow<T extends object, D = never> = T & {
  instanceState: InstanceState
  instanceStatus: string
  detail: D | undefined
  detailPhase: "checking" | "ready" | "error"
}

const emptyRows: Array<never> = []
export const loadingInfraTableSource: DataTableSource<never> = {
  rows: emptyRows,
  body: { kind: "loading" },
  refreshing: false,
}

const combineInventory = (
  queries: Array<UseQueryResult<InstanceInventory, Error>>
) =>
  queries.map((query) => ({
    state: instanceStateFromQuery({ ...query, data: query.data?.observation }),
    inventory:
      query.fetchStatus === "idle" &&
      query.isFetchedAfterMount &&
      !query.isError
        ? query.data
        : undefined,
  }))

/** Directory rows own existence. Live lookups enrich them without gating them. */
export function useInfraTableSource<T extends object, D = never>({
  directory,
  reference,
  error,
  retry,
  view = "status",
  selectDetail,
}: {
  directory: { data?: Array<T>; isLoading: boolean; isError: boolean }
  reference: (row: T) => InstanceReference
  error: Error
  retry: () => void
  view?: InstanceInventoryView
  selectDetail?: (inventory: InstanceInventory) => D | undefined
}) {
  const rows = directory.data ?? emptyRows
  const states = useQueries({
    queries: rows.map((row) =>
      instanceInventoryQueryOptions(reference(row), view)
    ),
    combine: combineInventory,
  })
  const [cache] = React.useState(() => new WeakMap<T, InfraInstanceRow<T, D>>())
  const enriched = React.useMemo(
    () =>
      rows.map((row, index) => {
        const entry = states[index]!
        const next = entry.state
        const detail = entry.inventory
          ? selectDetail?.(entry.inventory)
          : undefined
        const detailPhase =
          next.phase === "ready"
            ? "ready"
            : next.phase === "error"
              ? "error"
              : "checking"
        const previous = cache.get(row)
        const before = previous?.instanceState
        // Preserve unchanged row identities so TanStack Table's memoized rows
        // only repaint when their own directory, observation, or detail changes.
        const sameState =
          before?.phase === next.phase &&
          (next.phase === "checking" ||
            (next.phase === "ready" &&
              before.phase === "ready" &&
              before.observation === next.observation) ||
            (next.phase === "error" &&
              before.phase === "error" &&
              before.error === next.error))
        if (
          previous &&
          sameState &&
          previous.detail === detail &&
          previous.detailPhase === detailPhase
        )
          return previous
        const result: InfraInstanceRow<T, D> = {
          ...row,
          instanceState: next,
          instanceStatus: instanceStatePresentation(next).label,
          detail,
          detailPhase,
        }
        cache.set(row, result)
        return result
      }),
    [rows, states, selectDetail, cache]
  )
  const source = useLiveDataTableSource({
    data: directory.data ? enriched : undefined,
    error,
    isError: directory.isError,
    isLoading: directory.isLoading,
    retry,
  })
  return source
}
