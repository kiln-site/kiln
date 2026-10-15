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

// The scheme's default port goes unsaid, and any other port stands alone
// without the scheme.
export function relayAddress(
  relay: Pick<RelayDirectoryEntry, "hostname" | "port" | "useTls">
): string {
  const host =
    relay.hostname.includes(":") && !relay.hostname.startsWith("[")
      ? `[${relay.hostname}]`
      : relay.hostname
  const scheme = relay.useTls ? "https" : "http"
  return relay.port === (relay.useTls ? 443 : 80)
    ? `${scheme}://${host}`
    : `${host}:${relay.port}`
}
