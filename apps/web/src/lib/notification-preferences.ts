import { Predicate } from "effect"
import { z } from "zod"

import {
  formerNotificationKinds,
  type NotificationKind,
  type NotificationResource,
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

/**
 * Whose instances a person hears about: everything they can reach, or leaving
 * out what only their role reaches, or only their own. Invitations and such
 * are addressed to them, so this doesn't touch those.
 */
export const notificationScopes = ["all", "shared", "own"] as const
export type NotificationScope = (typeof notificationScopes)[number]

export const notificationScopeLabels = {
  all: "Everything I can access",
  own: "Only mine",
  shared: "Mine and shared with me",
} satisfies Record<NotificationScope, string>

/** What a person can turn off about one resource, by what it can send. */
export const resourceNotificationKinds = {
  app: ["app.deployed", "app.image-update", "security.report"],
  database: ["resource.disk-limit", "security.report"],
  instance: ["security.report"],
  relay: ["kiln.updated", "security.report"],
} as const satisfies Record<
  NotificationResource["type"],
  ReadonlyArray<NotificationKind>
>

/**
 * What a person turned off about one resource. It keeps the resource's name
 * so settings can list it without loading every resource.
 */
export interface NotificationResourcePreference {
  kinds: Partial<Record<NotificationKind, false>>
  name: string
  type: NotificationResource["type"]
}

export interface NotificationPreferences {
  /** Minutes without input after which an open tab counts as away. */
  idleMinutes: number
  kinds: Record<NotificationKind, NotificationKindPreference>
  /** Keyed by `notificationResourceKey`. */
  resources: Record<string, NotificationResourcePreference>
  scope: NotificationScope
  /** Which vulnerabilities in what the user can update notify them. */
  security: SecurityNotificationSettings
  /** Skip the push for a notification an active tab already showed. */
  skipPushWhileActive: boolean
}

/**
 * Where a notification can reach someone, in the order settings lists them.
 * Each notification chooses among these in one menu, so a new channel adds a
 * line here rather than a column to every row.
 */
export const notificationChannels = [
  { key: "inbox", label: "In Kiln" },
  { key: "push", label: "Push" },
] as const satisfies ReadonlyArray<{
  key: keyof NotificationKindPreference
  label: string
}>

/** The kinds a person can choose about, in the order settings lists them. */
export const notificationPreferenceGroups = [
  {
    id: "instances",
    kinds: [
      {
        description: "Someone else or Kiln deployed an App.",
        kind: "app.deployed",
        label: "Deployments",
      },
      {
        description: "An App's image has a newer version.",
        kind: "app.image-update",
        label: "App updates available",
      },
      {
        description: "A scan found new vulnerabilities.",
        kind: "security.report",
        label: "Vulnerability reports",
      },
      {
        description: "A database outgrew its disk limit.",
        kind: "resource.disk-limit",
        label: "Disk limit warnings",
      },
      // A finished move waits in the inbox to offer deleting the old server.
      {
        description: "A move or copy you started ended.",
        inboxRequired: true,
        kind: "server.migration",
        label: "Game Server moves and copies",
      },
    ],
    label: "Instances",
  },
  {
    id: "access",
    kinds: [
      // Invitations wait in the inbox for an answer, so they always arrive.
      {
        description: "Someone invited you to an instance.",
        inboxRequired: true,
        kind: "access.invited",
        label: "Invitations",
      },
      {
        description: "Someone removed your access.",
        kind: "access.removed",
        label: "Access removed",
      },
    ],
    label: "Access",
  },
  {
    id: "kiln",
    kinds: [
      {
        adminOnly: true,
        description: "A new Kiln release is out.",
        kind: "kiln.release",
        label: "Update available",
      },
      {
        description: "Hearth or a Relay moved to a newer version.",
        kind: "kiln.updated",
        label: "Kiln updated",
      },
    ],
    label: "Kiln",
  },
] as const satisfies ReadonlyArray<{
  id: string
  kinds: ReadonlyArray<{
    adminOnly?: boolean
    description: string
    inboxRequired?: boolean
    kind: NotificationKind
    label: string
  }>
  label: string
}>

/** How settings names a kind, without its section. */
export function notificationKindLabel(kind: NotificationKind): string {
  for (const group of notificationPreferenceGroups)
    for (const entry of group.kinds) if (entry.kind === kind) return entry.label
  return kind
}

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

const scopeSchema = z.enum(notificationScopes)

const resourcePreferenceSchema = z.object({
  kinds: z.record(z.string(), z.literal(false)),
  name: z.string().min(1).max(191),
  type: z.enum(["app", "database", "instance", "relay"]),
})

// However long `notificationResourceKey` gets; this is one person's setting.
const resourceKeySchema = z
  .string()
  .max(160)
  .regex(/^(app|database|instance|relay):[^:]+:[^:]+$/)

// Enough for anyone, and a limit on what one setting can grow to.
const resourcePreferenceLimit = 500

interface StoredPreferences {
  idleMinutes?: number
  kinds?: Record<string, StoredKind>
  resources?: Record<string, NotificationResourcePreference>
  scope?: NotificationScope
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
  const resources: Record<string, NotificationResourcePreference> = {}
  if (
    Predicate.hasProperty(value, "resources") &&
    Predicate.isObject(value.resources)
  )
    for (const [key, choice] of Object.entries(value.resources)) {
      const read = parsed(resourcePreferenceSchema, choice)
      if (read) resources[key] = read as NotificationResourcePreference
    }
  return {
    idleMinutes: Predicate.hasProperty(value, "idleMinutes")
      ? parsed(idleMinutesSchema, value.idleMinutes)
      : undefined,
    kinds,
    resources,
    scope: Predicate.hasProperty(value, "scope")
      ? parsed(scopeSchema, value.scope)
      : undefined,
    security: Predicate.hasProperty(value, "security")
      ? parsed(storedSecuritySchema, value.security)
      : undefined,
    skipPushWhileActive: Predicate.hasProperty(value, "skipPushWhileActive")
      ? parsed(z.boolean(), value.skipPushWhileActive)
      : undefined,
  }
}

// What's off for a resource, under the names kinds go by now.
function currentResourceKinds(
  kinds: NotificationResourcePreference["kinds"]
): NotificationResourcePreference["kinds"] {
  const current: Record<string, false> = { ...kinds }
  for (const [kind, former] of Object.entries(formerNotificationKinds))
    for (const name of former)
      if (name in current) {
        delete current[name]
        current[kind] = false
      }
  return current
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
    resources: Object.fromEntries(
      Object.entries(stored.resources ?? {}).map(([key, resource]) => [
        key,
        { ...resource, kinds: currentResourceKinds(resource.kinds) },
      ])
    ),
    scope: stored.scope ?? "all",
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
  // A resource's new choices, or null to go back to following the settings.
  resources: z
    .record(resourceKeySchema, resourcePreferenceSchema.strict().nullable())
    .refine((resources) => Object.keys(resources).length <= 50)
    .optional(),
  scope: scopeSchema.optional(),
  security: storedSecuritySchema.optional(),
  skipPushWhileActive: z.boolean().optional(),
})

export type NotificationPreferencesUpdate = z.infer<
  typeof notificationPreferencesUpdateSchema
>

/** A save's changes to the per-resource choices, oldest dropped past the limit. */
export function mergeResourcePreferences(
  current: Record<string, NotificationResourcePreference> | undefined,
  update: NotificationPreferencesUpdate["resources"]
) {
  const merged = { ...current }
  for (const [key, choice] of Object.entries(update ?? {})) {
    delete merged[key]
    if (choice) merged[key] = choice as NotificationResourcePreference
  }
  return Object.fromEntries(
    Object.entries(merged).slice(-resourcePreferenceLimit)
  )
}

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
    resources: mergeResourcePreferences(base.resources, update.resources),
    ...((base.scope || update.scope) && {
      scope: update.scope ?? base.scope,
    }),
    ...((base.security || update.security) && {
      security: { ...base.security, ...update.security },
    }),
  }
}
