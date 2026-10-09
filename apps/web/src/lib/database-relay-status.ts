import type { getManagedDatabases } from "@/server/databases"

type ManagedDatabaseOverview = Awaited<ReturnType<typeof getManagedDatabases>>

export interface DatabaseRelayStatus {
  status: "connected" | "unreachable"
  updating: boolean
}

/**
 * Applies live Relay reachability to database rows, keeping the overview's
 * identity when nothing changes. Realtime Relay status events own these two
 * fields; inventory responses can be older than the latest event.
 */
export function withDatabaseRelayStatus(
  overview: ManagedDatabaseOverview,
  statuses: ReadonlyMap<string, DatabaseRelayStatus>
): ManagedDatabaseOverview {
  let changed = false
  const databases = overview.databases.map((database) => {
    const relay = statuses.get(database.relayId)
    if (
      !relay ||
      (database.relayStatus === relay.status &&
        database.relayUpdating === relay.updating)
    ) {
      return database
    }
    changed = true
    return {
      ...database,
      relayStatus: relay.status,
      relayUpdating: relay.updating,
    }
  })
  return changed ? { ...overview, databases } : overview
}

/**
 * Whether a returning Relay may have inventory the overview hasn't seen: rows
 * fetched while it was away, or a failed inventory that returned no rows.
 */
export function databaseInventoryStale(
  overview: ManagedDatabaseOverview,
  relayId: string
): boolean {
  return (
    overview.relayErrors.some((error) => error.relayId === relayId) ||
    overview.databases.some(
      (database) =>
        database.relayId === relayId &&
        (database.inventoryStatus === "unavailable" ||
          database.relayStatus === "unreachable")
    )
  )
}
