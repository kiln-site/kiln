import { partKey } from "@/operations/lanes"

/**
 * The lane keys Tailscale networks take (docs/hearth-operations.md).
 * Creating or removing a network takes it whole. Saving its members, setting
 * up its Tailscale connection, syncing it and rewriting its DNS take its
 * `#settings`, so they go one at a time. Its Relays order what each of them
 * sends them.
 */

/** A Tailscale network: creating or removing it. */
export const tailscaleNetworkKey = (id: string) => `tailscale-network:${id}`

/** Its members, its Tailscale connection, and its DNS. */
export const tailscaleNetworkSettingsKey = (id: string) =>
  partKey(tailscaleNetworkKey(id), "settings")
