import * as React from "react"
import {
  queryOptions,
  useQuery,
  type QueryObserverResult,
} from "@tanstack/react-query"
import type {
  InstanceObservation,
  InstanceReference,
} from "@workspace/contracts"
import {
  instanceInventoryQueryKey,
  instanceInventoryQueryOptions,
} from "@/lib/instance-inventory"

export type InstanceState =
  | { phase: "checking" }
  | { phase: "error"; error: Error }
  | { phase: "ready"; observation: InstanceObservation }

export { InstanceInventoryError as InstanceStateError } from "@/lib/instance-inventory"

export function instanceStateQueryKey(reference: InstanceReference) {
  return instanceInventoryQueryKey(reference, "status")
}

export function instanceStateQueryOptions(reference: InstanceReference) {
  return queryOptions({
    ...instanceInventoryQueryOptions(reference, "status"),
    select: (inventory) => inventory.observation,
  })
}

export function useInstanceState(
  reference: InstanceReference,
  enabled = true
): InstanceState {
  const query = useQuery({
    ...instanceStateQueryOptions(reference),
    enabled: enabled && typeof window !== "undefined",
  })
  return instanceStateFromQuery(query)
}

export function instanceStateFromQuery(
  query: Pick<
    QueryObserverResult<InstanceObservation, Error>,
    "fetchStatus" | "isFetchedAfterMount" | "error" | "data"
  >
): InstanceState {
  // Query retains data during refetches; runtime state must be checked again
  // before this observer presents it as current.
  if (query.fetchStatus !== "idle" || !query.isFetchedAfterMount)
    return { phase: "checking" }
  if (query.error) return { phase: "error", error: query.error }
  return query.data
    ? { phase: "ready", observation: query.data }
    : { phase: "checking" }
}

export function useInstanceInventoryState(
  query: Pick<
    QueryObserverResult<
      import("@workspace/contracts").InstanceInventory,
      Error
    >,
    "data" | "error" | "fetchStatus" | "isFetchedAfterMount"
  >
): InstanceState {
  const { data, error, fetchStatus, isFetchedAfterMount } = query
  return React.useMemo(
    () =>
      instanceStateFromQuery({
        data: data?.observation,
        error,
        fetchStatus,
        isFetchedAfterMount,
      }),
    [data, error, fetchStatus, isFetchedAfterMount]
  )
}
