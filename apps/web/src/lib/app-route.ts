import {
  databaseRouteIdentifier,
  resolveDatabaseRoute,
} from "@/lib/database-route"
import type { getAppDirectory } from "@/server/apps"

export type AppDirectoryEntry = Awaited<
  ReturnType<typeof getAppDirectory>
>[number]

// Apps resolve their routes like databases: the short ID, or the full ID when
// two apps share one.
export const resolveAppRoute = resolveDatabaseRoute
export const appRouteIdentifier = databaseRouteIdentifier

// The sidebar remembers its selection in one cookie; apps carry this prefix
// so server and database route resolution never match them.
const APP_SELECTION_PREFIX = "app:"

export function appSelectionRouteId(routeId: string): string {
  return `${APP_SELECTION_PREFIX}${routeId}`
}

export function appRouteIdFromSelection(
  selection: string | null | undefined
): string | null {
  return selection?.startsWith(APP_SELECTION_PREFIX)
    ? selection.slice(APP_SELECTION_PREFIX.length)
    : null
}
