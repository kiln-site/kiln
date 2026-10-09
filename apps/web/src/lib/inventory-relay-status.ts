// Database and app inventories come from their Relays; these keep their rows
// in step with live Relay reachability between inventory refreshes.

export interface InventoryRelayStatus {
  status: "connected" | "unreachable"
  updating: boolean
}

interface InventoryRow {
  inventoryStatus: "available" | "missing" | "unavailable"
  relayId: string
  relayStatus: "connected" | "unreachable"
  relayUpdating: boolean
}

type InventoryOverview<K extends string> = {
  [key in K]: ReadonlyArray<InventoryRow>
} & { relayErrors: ReadonlyArray<{ relayId: string }> }

/**
 * Applies live Relay reachability to an inventory's rows, keeping the
 * overview's identity when nothing changes. Realtime Relay status events own
 * these two fields; inventory responses can be older than the latest event.
 */
export function withInventoryRelayStatus<
  K extends string,
  O extends InventoryOverview<K>,
>(overview: O, key: K, statuses: ReadonlyMap<string, InventoryRelayStatus>): O {
  let changed = false
  const rows = overview[key].map((row) => {
    const relay = statuses.get(row.relayId)
    if (
      !relay ||
      (row.relayStatus === relay.status && row.relayUpdating === relay.updating)
    ) {
      return row
    }
    changed = true
    return { ...row, relayStatus: relay.status, relayUpdating: relay.updating }
  })
  return changed ? { ...overview, [key]: rows } : overview
}

/**
 * Whether a returning Relay may have inventory the overview hasn't seen: rows
 * fetched while it was away, or a failed inventory that returned no rows.
 */
export function inventoryStale<K extends string>(
  overview: InventoryOverview<K>,
  key: K,
  relayId: string
): boolean {
  return (
    overview.relayErrors.some((error) => error.relayId === relayId) ||
    overview[key].some(
      (row) =>
        row.relayId === relayId &&
        (row.inventoryStatus === "unavailable" ||
          row.relayStatus === "unreachable")
    )
  )
}
