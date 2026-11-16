import { partKey } from "@/operations/lanes"

/**
 * The lane keys tunnels take (docs/hearth-operations.md). Creating or
 * removing a tunnel takes it whole. Saving its gateways and their members,
 * setting up its Tailscale connection, syncing it and rewriting its DNS take
 * its `#settings`, so they go one at a time. Its Relays order what each of
 * them sends them.
 */

/** A tunnel: creating or removing it. */
export const tunnelKey = (id: string) => `tunnel:${id}`

/** Its gateways and their members, its Tailscale connection, and its DNS. */
export const tunnelSettingsKey = (id: string) =>
  partKey(tunnelKey(id), "settings")
