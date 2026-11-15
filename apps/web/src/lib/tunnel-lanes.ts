import { partKey } from "@/operations/lanes"

/**
 * The lane keys tailnets take (docs/hearth-operations.md). Creating or
 * removing a tailnet takes it whole. Saving its tunnels and their members,
 * setting up its Tailscale connection, syncing it and rewriting its DNS take
 * its `#settings`, so they go one at a time. Its Relays order what each of
 * them sends them.
 */

/** A tailnet: creating or removing it. */
export const tailnetKey = (id: string) => `tailnet:${id}`

/** Its tunnels and their members, its Tailscale connection, and its DNS. */
export const tailnetSettingsKey = (id: string) =>
  partKey(tailnetKey(id), "settings")
