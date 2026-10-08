import { z } from "zod"

export const instanceFavoriteSchema = z.strictObject({
  id: z.string().min(1).max(64),
  kind: z.enum(["server", "database", "relay"]),
  relayId: z.string().min(1).max(43),
})

/** A server, database, or Relay the user starred. Relays use their own ID. */
export type InstanceFavorite = z.infer<typeof instanceFavoriteSchema>

export function instanceFavoriteKey(favorite: InstanceFavorite): string {
  return `${favorite.kind}:${favorite.relayId}:${favorite.id}`
}
