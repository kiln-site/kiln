import { z } from "zod"

export const hearthRealtimeTopics = [
  "access",
  "activity",
  "backup-settings",
  "backup-storage",
  "backups",
  "database-credentials",
  "database-directory",
  "databases",
  "domains",
  "file-activity",
  "preferences",
  "relay-health",
  "relay-proxy",
  "relays",
  "schedules",
  "tailscale",
] as const

export const hearthRealtimeTopicSchema = z.enum(hearthRealtimeTopics)

export type HearthRealtimeTopic = z.infer<typeof hearthRealtimeTopicSchema>

export interface HearthRealtimeScope {
  databaseId?: string
  instanceId?: string
  relayId: string
}

export type HearthRealtimeAudience =
  | { kind: "authenticated" }
  | { kind: "backup-storage"; ownerUserId: string | null }
  | { kind: "platform-admins" }
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
  if (audience.kind === "backup-storage") {
    return (
      audience.ownerUserId === null ||
      policy.isPlatformAdmin ||
      audience.ownerUserId === policy.userId
    )
  }
  if (audience.kind === "platform-admins") return policy.isPlatformAdmin
  if (audience.kind === "users") {
    return audience.userIds.includes(policy.userId)
  }
  if (audience.kind === "relay-managers") return policy.canManageRelays
  return (
    policy.isPlatformAdmin ||
    audience.relayIds.some((relayId) => policy.readableRelays.has(relayId))
  )
}
