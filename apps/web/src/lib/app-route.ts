import type { getAppDirectory } from "@/server/apps"
import {
  resolveShortIdRoute,
  shortIdRouteIdentifier,
  shortIdRouteSelection,
} from "@/lib/short-id-route"

export type AppDirectoryEntry = Awaited<
  ReturnType<typeof getAppDirectory>
>[number]

export const resolveAppRoute = resolveShortIdRoute
export const appRouteIdentifier = shortIdRouteIdentifier

const appSelection = shortIdRouteSelection("app")
export const appSelectionRouteId = appSelection.toSelection
export const appRouteIdFromSelection = appSelection.fromSelection
