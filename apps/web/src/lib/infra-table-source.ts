import * as React from "react"
import { useQueries, type UseQueryResult } from "@tanstack/react-query"
import type {
  InstanceReference,
  InstanceObservation,
} from "@workspace/contracts"

import { useLiveDataTableSource } from "@/lib/data-table-source"
import {
  instanceStateFromQuery,
  instanceStateQueryOptions,
  type InstanceState,
} from "@/lib/instance-state"
import { instanceStatePresentation } from "@/lib/instance-state-presentation"

export type InfraInstanceRow<T extends object, D = never> = T & {
  instanceState: InstanceState
  instanceStatus: string
  detail: D | undefined
  detailPhase: "checking" | "ready" | "error"
}

const emptyRows: Array<never> = []
const combineStates = (
  queries: Array<UseQueryResult<InstanceObservation, Error>>
) => queries.map(instanceStateFromQuery)

export function useInfraDetails<T extends { id: string; relayId: string }>(
  query: Pick<
    UseQueryResult,
    "fetchStatus" | "isFetchedAfterMount" | "isError"
  >,
  rows: ReadonlyArray<T> | undefined
) {
  return React.useMemo(
    () => ({
      byKey: new Map(rows?.map((row) => [`${row.relayId}:${row.id}`, row])),
      phase:
        query.fetchStatus !== "idle" || !query.isFetchedAfterMount
          ? ("checking" as const)
          : query.isError
            ? ("error" as const)
            : ("ready" as const),
    }),
    [rows, query.fetchStatus, query.isFetchedAfterMount, query.isError]
  )
}

/** Directory rows own existence. Live lookups enrich them without gating them. */
export function useInfraTableSource<T extends object, D = never>({
  directory,
  reference,
  error,
  retry,
  details,
}: {
  directory: { data?: Array<T>; isLoading: boolean; isError: boolean }
  reference: (row: T) => InstanceReference
  error: Error
  retry: () => void
  details?: {
    byKey: ReadonlyMap<string, D>
    phase: "checking" | "ready" | "error"
  }
}) {
  const rows = directory.data ?? emptyRows
  const states = useQueries({
    queries: rows.map((row) => instanceStateQueryOptions(reference(row))),
    combine: combineStates,
  })
  const [cache] = React.useState(() => new WeakMap<T, InfraInstanceRow<T, D>>())
  const enriched = React.useMemo(
    () =>
      rows.map((row, index) => {
        const next = states[index]!
        const ref = reference(row)
        const detail = details?.byKey.get(`${ref.relayId}:${ref.id}`)
        const detailPhase = details?.phase ?? "ready"
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
    [rows, states, details, reference, cache]
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
