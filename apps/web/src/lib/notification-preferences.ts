import { Predicate } from "effect"
import { z } from "zod"

import {
  formerNotificationKinds,
  type NotificationKind,
} from "@/lib/notifications"
import {
  defaultSecurityNotificationSettings,
  securityNotificationSettingsSchema,
  type SecurityNotificationSettings,
} from "@/lib/security"

// What each user hears about, and how: per kind, whether it reaches the inbox
// and whether it's pushed to their devices, and whether a push waits to see
// if they're already looking at Kiln. Stored as one JSON setting per user, so
// a kind this version doesn't know keeps its stored choice.

export interface NotificationKindPreference {
  inbox: boolean
  push: boolean
}

export interface NotificationPreferences {
  /** Minutes without input after which an open tab counts as away. */
  idleMinutes: number
  kinds: Record<NotificationKind, NotificationKindPreference>
  /** Which vulnerabilities in what the user can update notify them. */
  security: SecurityNotificationSettings
  /** Skip the push for a notification an active tab already showed. */
  skipPushWhileActive: boolean
}

/** The kinds a person can choose about, in the order settings lists them. */
export const notificationPreferenceGroups = [
  {
    adminOnly: true,
    id: "kiln",
    kinds: [
      { kind: "kiln.release", label: "Update available" },
      { kind: "kiln.updated", label: "Updated" },
    ],
    label: "Kiln",
  },
  {
    adminOnly: false,
    id: "apps",
    kinds: [
      { kind: "app.image-update", label: "Update available" },
      { kind: "app.deployed", label: "Deployments" },
    ],
    label: "Apps",
  },
  {
    adminOnly: false,
    id: "security",
    kinds: [{ kind: "security.report", label: "Vulnerability reports" }],
    label: "Security",
  },
  {
    adminOnly: false,
    id: "resources",
    kinds: [
      { kind: "resource.disk-limit", label: "Disk limit warnings" },
      // A finished move waits in the inbox to offer deleting the old server.
      {
        inboxRequired: true,
        kind: "server.migration",
        label: "Game Server moves and copies",
      },
    ],
    label: "Resources",
  },
  {
    adminOnly: false,
    id: "access",
    kinds: [
      // Invitations wait in the inbox for an answer, so they always arrive.
      { inboxRequired: true, kind: "access.invited", label: "Invitations" },
      { kind: "access.removed", label: "Access removed" },
    ],
    label: "Access",
  },
] as const satisfies ReadonlyArray<{
  adminOnly: boolean
  id: string
  kinds: ReadonlyArray<{
    inboxRequired?: boolean
    kind: NotificationKind
    label: string
  }>
  label: string
}>

/** The idle thresholds settings offers, in minutes. */
export const notificationIdleMinuteOptions = [1, 2, 5, 10, 15, 30] as const

const defaultIdleMinutes = 5

const kindsWithRequiredInbox: ReadonlySet<NotificationKind> = new Set(
  notificationPreferenceGroups.flatMap((group) =>
    group.kinds.flatMap((entry) =>
      "inboxRequired" in entry && entry.inboxRequired ? [entry.kind] : []
    )
  )
)

const allKinds: ReadonlyArray<NotificationKind> = [
  "kiln.release",
  "kiln.updated",
  "access.invited",
  "access.removed",
  "resource.disk-limit",
  "app.image-update",
  "app.deployed",
  "security.report",
  "server.migration",
] satisfies ReadonlyArray<NotificationKind>

const storedKindSchema = z.object({
  inbox: z.boolean().optional(),
  push: z.boolean().optional(),
})

type StoredKind = z.infer<typeof storedKindSchema>

const storedSecuritySchema = securityNotificationSettingsSchema.partial()

interface StoredPreferences {
  idleMinutes?: number
  kinds?: Record<string, StoredKind>
  security?: Partial<SecurityNotificationSettings>
  skipPushWhileActive?: boolean
}

const idleMinutesSchema = z.number().int().min(1).max(60)

function parsed<T>(schema: z.ZodType<T>, value: unknown): T | undefined {
  const result = schema.safeParse(value)
  return result.success ? result.data : undefined
}

// What's stored, field by field: a field this version can't read falls back
// to its default without losing the others.
function readStored(value: unknown): StoredPreferences {
  if (!Predicate.isObject(value)) return {}
  const kinds: Record<string, StoredKind> = {}
  if (Predicate.hasProperty(value, "kinds") && Predicate.isObject(value.kinds))
    for (const [kind, choice] of Object.entries(value.kinds)) {
      const read = parsed(storedKindSchema, choice)
      if (read) kinds[kind] = read
    }
  return {
    idleMinutes: Predicate.hasProperty(value, "idleMinutes")
      ? parsed(idleMinutesSchema, value.idleMinutes)
      : undefined,
    kinds,
    security: Predicate.hasProperty(value, "security")
      ? parsed(storedSecuritySchema, value.security)
      : undefined,
    skipPushWhileActive: Predicate.hasProperty(value, "skipPushWhileActive")
      ? parsed(z.boolean(), value.skipPushWhileActive)
      : undefined,
  }
}

/** Choices for every kind, filling in defaults for what wasn't stored. */
export function normalizeNotificationPreferences(
  value: unknown
): NotificationPreferences {
  const stored = readStored(value)
  const kinds = {} as Record<NotificationKind, NotificationKindPreference>
  for (const kind of allKinds) {
    const choice = [kind, ...(formerNotificationKinds[kind] ?? [])]
      .map((name) => stored.kinds?.[name])
      .find((found) => found !== undefined)
    kinds[kind] = {
      inbox: kindsWithRequiredInbox.has(kind) ? true : (choice?.inbox ?? true),
      push: choice?.push ?? true,
    }
  }
  return {
    idleMinutes: stored.idleMinutes ?? defaultIdleMinutes,
    kinds,
    security: { ...defaultSecurityNotificationSettings, ...stored.security },
    skipPushWhileActive: stored.skipPushWhileActive ?? true,
  }
}

export const defaultNotificationPreferences =
  normalizeNotificationPreferences(null)

/** What a save may send: any subset of the choices. */
export const notificationPreferencesUpdateSchema = z.strictObject({
  idleMinutes: z
    .number()
    .int()
    .refine((minutes) =>
      (notificationIdleMinuteOptions as ReadonlyArray<number>).includes(minutes)
    )
    .optional(),
  kinds: z
    .partialRecord(
      z.enum(allKinds as [NotificationKind, ...Array<NotificationKind>]),
      z.strictObject({ inbox: z.boolean(), push: z.boolean() })
    )
    .optional(),
  security: storedSecuritySchema.optional(),
  skipPushWhileActive: z.boolean().optional(),
})

export type NotificationPreferencesUpdate = z.infer<
  typeof notificationPreferencesUpdateSchema
>

/**
 * Applies a save to what's stored, keeping kinds this version doesn't know.
 */
export function mergeNotificationPreferences(
  stored: unknown,
  update: NotificationPreferencesUpdate
) {
  const base = readStored(stored)
  return {
    ...base,
    ...(update.idleMinutes !== undefined && {
      idleMinutes: update.idleMinutes,
    }),
    ...(update.skipPushWhileActive !== undefined && {
      skipPushWhileActive: update.skipPushWhileActive,
    }),
    kinds: { ...base.kinds, ...update.kinds },
    ...((base.security || update.security) && {
      security: { ...base.security, ...update.security },
    }),
  }
}
