import * as React from "react"
import { useQueries, type UseQueryResult } from "@tanstack/react-query"
import type {
  InstanceInventory,
  InstanceInventoryView,
  InstanceReference,
} from "@workspace/contracts"

import type { DataTableSource } from "@/lib/data-table-source"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"
import {
  inventoryInstanceState,
  type InstanceState,
} from "@/lib/instance-state"

export type InfraInstanceRow<T extends object, D = never> = T & {
  instanceState: InstanceState
  /** The status label, so search and sorting match the status cell. */
  instanceStatus: string
  /** View-specific data, present once the row's observation is confirmed. */
  detail: D | undefined
}

const noRows: Array<never> = []
export const loadingInfraTableSource: DataTableSource<never> = {
  rows: noRows,
  body: { kind: "loading" },
  refreshing: false,
}

const combine = (queries: Array<UseQueryResult<InstanceInventory, Error>>) =>
  queries.map((query) => {
    const state = inventoryInstanceState(query)
    return {
      state,
      inventory: state.phase === "ready" ? query.data : undefined,
    }
  })

/**
 * Directory rows own existence and render at once. Each row's observation,
 * and any view data, loads through its own batched query and replaces only
 * that row when it changes.
 */
export function useInfraTableSource<T extends object, D = never>({
  rows,
  reference,
  view = "status",
  selectDetail,
}: {
  rows: Array<T>
  reference: (row: T) => InstanceReference
  view?: InstanceInventoryView
  selectDetail?: (inventory: InstanceInventory) => D | undefined
}): DataTableSource<InfraInstanceRow<T, D>> {
  const observations = useQueries({
    queries: rows.map((row) =>
      instanceInventoryQueryOptions(reference(row), view)
    ),
    combine,
  })
  const [cache] = React.useState(() => ({
    rows: new WeakMap<T, InfraInstanceRow<T, D>>(),
    last: noRows as Array<InfraInstanceRow<T, D>>,
  }))
  const enriched = React.useMemo(() => {
    const next = rows.map((row, index) => {
      const { state, inventory } = observations[index]!
      const detail = inventory ? selectDetail?.(inventory) : undefined
      const previous = cache.rows.get(row)
      // Keep unchanged rows identical so the memoized table repaints only
      // the rows whose directory entry, observation, or detail changed.
      if (previous?.instanceState === state && previous.detail === detail)
        return previous
      const enrichedRow: InfraInstanceRow<T, D> = {
        ...row,
        instanceState: state,
        instanceStatus: instanceStatePresentation(state).label,
        detail,
      }
      cache.rows.set(row, enrichedRow)
      return enrichedRow
    })
    // Background refetches change fetch status without changing any row.
    if (
      next.length === cache.last.length &&
      next.every((row, index) => row === cache.last[index])
    )
      return cache.last
    cache.last = next
    return next
  }, [rows, observations, selectDetail, cache])
  return React.useMemo(
    () => ({ rows: enriched, body: { kind: "ready" }, refreshing: false }),
    [enriched]
  )
}
