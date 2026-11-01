import { partKey } from "@/operations/lanes"

/**
 * The lane keys Tailscale networks take (docs/hearth-operations.md).
 * Creating or removing a network takes it whole. Saving its members, setting
 * up its Tailscale connection and syncing it take its `#settings`, so they
 * go one at a time. Its Relays order what each of them sends them, and a
 * member's deletion rewrites its DNS through them, outside these lanes.
 */

/** A Tailscale network: creating or removing it. */
export const tailscaleNetworkKey = (id: string) => `tailscale-network:${id}`

/** Its members, its Tailscale connection, and what that holds. */
export const tailscaleNetworkSettingsKey = (id: string) =>
  partKey(tailscaleNetworkKey(id), "settings")
