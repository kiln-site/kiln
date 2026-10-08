import type { getManagedDatabaseDirectory } from "@/server/databases"

export type ManagedDatabaseDirectoryEntry = Awaited<
  ReturnType<typeof getManagedDatabaseDirectory>
>[number]

export type DatabaseRouteResolution<T> =
  | { status: "found"; database: T }
  | { status: "ambiguous" }
  | { status: "not-found" }

const SHORT_ID_LENGTH = 8

// Database routes use the short ID, like servers. The full ID always works and
// becomes the canonical form only when two databases share a short ID.
export function resolveDatabaseRoute<T extends { id: string }>(
  databases: ReadonlyArray<T>,
  routeId: string | null | undefined
): DatabaseRouteResolution<T> {
  if (!routeId) return { status: "not-found" }
  const exact = databases.find((database) => database.id === routeId)
  if (exact) return { status: "found", database: exact }
  if (routeId.length !== SHORT_ID_LENGTH) return { status: "not-found" }
  const matches = databases.filter((database) =>
    database.id.startsWith(routeId)
  )
  if (matches.length > 1) return { status: "ambiguous" }
  return matches[0]
    ? { status: "found", database: matches[0] }
    : { status: "not-found" }
}

export function databaseRouteIdentifier(
  databases: ReadonlyArray<{ id: string }>,
  database: { id: string }
): string {
  const shortId = database.id.slice(0, SHORT_ID_LENGTH)
  const shared = databases.some(
    (candidate) =>
      candidate.id !== database.id && candidate.id.startsWith(shortId)
  )
  return shared ? database.id : shortId
}

// The sidebar remembers servers and databases in one cookie; databases carry
// this prefix so server route resolution never matches them.
const DATABASE_SELECTION_PREFIX = "db:"

export function databaseSelectionRouteId(routeId: string): string {
  return `${DATABASE_SELECTION_PREFIX}${routeId}`
}

export function databaseRouteIdFromSelection(
  selection: string | null | undefined
): string | null {
  return selection?.startsWith(DATABASE_SELECTION_PREFIX)
    ? selection.slice(DATABASE_SELECTION_PREFIX.length)
    : null
}
