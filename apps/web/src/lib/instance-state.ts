import { queryOptions, useQuery } from "@tanstack/react-query"
import type {
  InstanceInventory,
  InstanceObservation,
  InstanceReference,
} from "@workspace/contracts"
import { instanceInventoryQueryOptions } from "@/lib/instance-inventory"

export type InstanceState =
  | { phase: "checking" }
  | { phase: "error"; error: Error }
  | { phase: "ready"; observation: InstanceObservation }

export interface InstanceQueryResult<TData> {
  data: TData | undefined
  error: Error | null
  isFetchedAfterMount: boolean
  status: "pending" | "error" | "success"
}

const checking: InstanceState = { phase: "checking" }
const states = new WeakMap<object, InstanceState>()

/**
 * Runtime state is only presented once this observer has confirmed it. A
 * cached observation from before mount shows as checking; later background
 * refreshes keep the confirmed observation until a newer one replaces it.
 */
export function instanceStateFromQuery(
  query: InstanceQueryResult<InstanceObservation>
): InstanceState {
  if (!query.isFetchedAfterMount) return checking
  if (query.status === "error" && query.error) return cached(query.error)
  return query.data ? cached(query.data) : checking
}

// Equal inputs produce the same state object, so memoized rows and cards
// skip renders while polling returns unchanged observations.
function cached(value: Error | InstanceObservation): InstanceState {
  let state = states.get(value)
  if (!state) {
    state =
      value instanceof Error
        ? { phase: "error", error: value }
        : { phase: "ready", observation: value }
    states.set(value, state)
  }
  return state
}

export function inventoryInstanceState(
  query: InstanceQueryResult<InstanceInventory>
): InstanceState {
  // Read fields individually: spreading a tracked query result would
  // subscribe its component to every fetch status change.
  return instanceStateFromQuery({
    data: query.data?.observation,
    error: query.error,
    isFetchedAfterMount: query.isFetchedAfterMount,
    status: query.status,
  })
}

export function instanceStateQueryOptions(reference: InstanceReference) {
  return queryOptions({
    ...instanceInventoryQueryOptions(reference, "status"),
    select: (inventory) => inventory.observation,
  })
}

export function useInstanceState(reference: InstanceReference): InstanceState {
  return instanceStateFromQuery(useQuery(instanceStateQueryOptions(reference)))
}
