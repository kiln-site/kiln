import { instanceIdSchema, relayIdSchema } from "@workspace/contracts"
import { z } from "zod"

// Kiln's own favorite names "kiln" for its ID and Relay.
export const instanceFavoriteSchema = z.strictObject({
  id: z.union([instanceIdSchema, z.literal("kiln")]),
  kind: z.enum(["server", "database", "relay", "app", "kiln"]),
  relayId: z.union([relayIdSchema, z.literal("kiln")]),
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
