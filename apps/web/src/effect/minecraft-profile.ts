import { Effect, Schema } from "effect"

import { ExternalServiceError } from "@/effect/errors"
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
const minecraftProfileCacheTtlMs = 60 * 60_000
const minecraftProfileCacheMaxEntries = 512
const minecraftProfileCache = new Map<
  string,
  { expiresAt: number; profile: MinecraftProfile | null }
>()
const pendingMinecraftProfiles = new Map<
  string,
  Promise<MinecraftProfile | null>
>()

export function clearMinecraftProfileCacheForTesting(): void {
  minecraftProfileCache.clear()
  pendingMinecraftProfiles.clear()
}

export type MinecraftProfile = typeof MinecraftProfileSchema.Type

export const resolveMinecraftProfileEffect = Effect.fn(
  "minecraft.profile.resolve"
)(function* (displayName: string) {
  const username = displayName.trim()
  if (!isMinecraftUsername(username)) return null
  const key = minecraftUsernameKey(username)
  const resolution = resolveCachedMinecraftProfile(key)

  return yield* Effect.tryPromise({
    try: () => resolution.request,
    catch: (cause) =>
      ExternalServiceError.make({
        cause,
        message:
          cause instanceof Error
            ? cause.message
            : "Mojang returned an invalid response",
        service: "Mojang",
      }),
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (
          resolution.created &&
          pendingMinecraftProfiles.get(key) === resolution.request
        ) {
          pendingMinecraftProfiles.delete(key)
        }
      })
    )
  )
})

function resolveCachedMinecraftProfile(
  key: string
): { created: boolean; request: Promise<MinecraftProfile | null> } {
  const cached = minecraftProfileCache.get(key)
  if (cached && cached.expiresAt > Date.now()) {
    return { created: false, request: Promise.resolve(cached.profile) }
  }
  if (cached) minecraftProfileCache.delete(key)

  const pending = pendingMinecraftProfiles.get(key)
  if (pending) return { created: false, request: pending }

  const request = fetchMinecraftProfile(key).then((profile) => {
    cacheMinecraftProfile(key, profile)
    return profile
  })
  pendingMinecraftProfiles.set(key, request)
  return { created: true, request }
}

function cacheMinecraftProfile(
  key: string,
  profile: MinecraftProfile | null
): void {
  const now = Date.now()
  minecraftProfileCache.delete(key)
  for (const [cachedKey, cached] of minecraftProfileCache) {
    if (cached.expiresAt <= now) minecraftProfileCache.delete(cachedKey)
  }
  while (minecraftProfileCache.size >= minecraftProfileCacheMaxEntries) {
    const oldestKey = minecraftProfileCache.keys().next().value
    if (oldestKey === undefined) break
    minecraftProfileCache.delete(oldestKey)
  }
  minecraftProfileCache.set(key, {
    expiresAt: now + minecraftProfileCacheTtlMs,
    profile,
  })
}

async function fetchMinecraftProfile(
  username: string
): Promise<MinecraftProfile | null> {
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
  return Schema.decodeUnknownSync(MinecraftProfileSchema)(await response.json())
}
