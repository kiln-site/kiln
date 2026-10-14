import type { getRelays } from "@/server/relays"
import {
  resolveShortIdRoute,
  shortIdRouteIdentifier,
  shortIdRouteSelection,
} from "@/lib/short-id-route"

export type RelayDirectoryEntry = Awaited<ReturnType<typeof getRelays>>[number]

export const resolveRelayRoute = resolveShortIdRoute
export const relayRouteIdentifier = shortIdRouteIdentifier

const relaySelection = shortIdRouteSelection("relay")
export const relaySelectionRouteId = relaySelection.toSelection
export const relayRouteIdFromSelection = relaySelection.fromSelection

export function relayAddress(
  relay: Pick<RelayDirectoryEntry, "hostname" | "port" | "useTls">
): string {
  return `${relay.useTls ? "https" : "http"}://${relay.hostname}:${relay.port}`
}
