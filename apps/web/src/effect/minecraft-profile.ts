import { Effect, Schema } from "effect"

import { ExternalServiceError } from "@/effect/errors"
import { readThroughCache } from "@/lib/cache"
import {
  isMinecraftUsername,
  minecraftUsernameKey,
} from "@/lib/minecraft-profile"

const MinecraftProfileSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
})
const mojangProfileBaseUrl = "https://api.mojang.com/users/profiles/minecraft"
const minecraftProfileHeaders = {
  Accept: "application/json",
  "User-Agent": "kiln-hearth",
}

const decodeCachedMinecraftProfile = Schema.decodeUnknownSync(
  Schema.NullOr(MinecraftProfileSchema)
)

export type MinecraftProfile = typeof MinecraftProfileSchema.Type

export const resolveMinecraftProfileEffect = Effect.fn(
  "minecraft.profile.resolve"
)(function* (displayName: string) {
  if (!isMinecraftUsername(displayName)) return null
  // Mojang usernames are case-insensitive, so every casing shares one entry.
  const username = minecraftUsernameKey(displayName)

  const load = Effect.tryPromise({
    try: async () => {
      const response = await fetch(
        `${mojangProfileBaseUrl}/${encodeURIComponent(username)}`,
        {
          headers: minecraftProfileHeaders,
          redirect: "follow",
          signal: AbortSignal.timeout(5_000),
        }
      )
      if (response.status === 204 || response.status === 404) return null
      if (!response.ok) {
        throw new Error(`Mojang returned HTTP ${response.status}`)
      }
      return Schema.decodeUnknownSync(MinecraftProfileSchema)(
        await response.json()
      )
    },
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message:
          cause instanceof Error
            ? cause.message
            : "Mojang returned an invalid response",
        service: "Mojang",
      }),
  })
  return yield* readThroughCache({
    decode: decodeCachedMinecraftProfile,
    load,
    policy: {
      key: `minecraft:profile:${username}`,
      name: "Minecraft profile",
      ttlMs: 60 * 60_000,
    },
  })
})
