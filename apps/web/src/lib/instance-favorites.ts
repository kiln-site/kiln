import { z } from "zod"

export const instanceFavoriteSchema = z.strictObject({
  id: z.string().min(1).max(64),
  kind: z.enum(["server", "database", "relay", "app", "kiln"]),
  relayId: z.string().min(1).max(43),
})

/**
 * A server, database, app, or Relay the user starred, or Kiln itself.
 * Relays use their own ID.
 */
export type InstanceFavorite = z.infer<typeof instanceFavoriteSchema>

/**
 * Kiln itself. There is one per Hearth and it can move between Relays, so its
 * favorite names no Relay. Platform administrators start with it starred.
 */
export const kilnFavorite: InstanceFavorite = {
  id: "kiln",
  kind: "kiln",
  relayId: "kiln",
}

export function instanceFavoriteKey(favorite: InstanceFavorite): string {
  return `${favorite.kind}:${favorite.relayId}:${favorite.id}`
}
