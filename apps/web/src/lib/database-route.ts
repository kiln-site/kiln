import type { getManagedDatabaseDirectory } from "@/server/databases"
import {
  resolveShortIdRoute,
  shortIdRouteIdentifier,
  shortIdRouteSelection,
} from "@/lib/short-id-route"

export type ManagedDatabaseDirectoryEntry = Awaited<
  ReturnType<typeof getManagedDatabaseDirectory>
>[number]

export const resolveDatabaseRoute = resolveShortIdRoute
export const databaseRouteIdentifier = shortIdRouteIdentifier

const databaseSelection = shortIdRouteSelection("db")
export const databaseSelectionRouteId = databaseSelection.toSelection
export const databaseRouteIdFromSelection = databaseSelection.fromSelection
