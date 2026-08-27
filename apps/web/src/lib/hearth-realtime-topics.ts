import { z } from "zod"

export const hearthRealtimeTopics = [
  "access",
  "domains",
  "file-activity",
  "preferences",
  "relays",
  "schedules",
] as const

export const hearthRealtimeTopicSchema = z.enum(hearthRealtimeTopics)

export type HearthRealtimeTopic = z.infer<typeof hearthRealtimeTopicSchema>

export interface HearthRealtimeScope {
  instanceId?: string
  relayId: string
}

export type HearthRealtimeAudience =
  | { kind: "authenticated" }
  | { kind: "relay-managers" }
  | { kind: "relays"; relayIds: Array<string> }
  | { kind: "users"; userIds: Array<string> }

export function hearthAudienceAllows(
  policy: {
    canManageRelays: boolean
    isPlatformAdmin: boolean
    readableRelays: ReadonlySet<string>
    userId: string
  },
  audience: HearthRealtimeAudience
): boolean {
  if (audience.kind === "authenticated") return true
  if (audience.kind === "users") {
    return audience.userIds.includes(policy.userId)
  }
  if (audience.kind === "relay-managers") return policy.canManageRelays
  return (
    policy.isPlatformAdmin ||
    audience.relayIds.some((relayId) => policy.readableRelays.has(relayId))
  )
}
