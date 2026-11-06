import { z } from "zod"

const releaseUrlSchema = z.url({ protocol: /^https$/ })

const notificationResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  relayId: z.string(),
  type: z.enum(["relay", "instance", "database", "app"]),
})

const severitySchema = z.enum([
  "critical",
  "high",
  "medium",
  "low",
  "negligible",
])

/**
 * What a notification says, stored as the row's `kind` plus JSON `data`.
 * Rows are kept across Kiln versions: only add kinds or optional fields, and
 * readers drop kinds they don't know.
 */
export const notificationContentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("kiln.release"),
    name: z.string(),
    url: releaseUrlSchema,
    version: z.string(),
  }),
  // Kiln moved to a newer version: Hearth, unless `hearth` says otherwise, and
  // `relays`. Each person has one, showing what they can update. A newer
  // update replaces it, adding in what it said while it's unread.
  z.object({
    hearth: z.boolean().optional(),
    kind: z.literal("kiln.updated"),
    relays: z.array(notificationResourceSchema).optional(),
    // Release names, e.g. "v0.1.0 Nightly #17", when GitHub listed them.
    name: z.string().optional(),
    previousName: z.string().optional(),
    previousVersion: z.string(),
    url: releaseUrlSchema.nullable(),
    version: z.string(),
  }),
  z.object({
    actorName: z.string(),
    invitationId: z.string(),
    kind: z.literal("access.invited"),
    // How the invitation ended: answered by the user, cancelled, or expired.
    outcome: z
      .enum(["accepted", "declined", "cancelled", "expired"])
      .optional(),
    resource: notificationResourceSchema,
  }),
  z.object({
    actorName: z.string(),
    kind: z.literal("access.removed"),
    resource: notificationResourceSchema,
  }),
  // An instance's data outgrew its disk limit. Instances that keep running
  // past it, such as databases, warn this way. `usedBytes` stays current, and
  // it goes away once the data fits again.
  z.object({
    kind: z.literal("resource.disk-limit"),
    limitBytes: z.number(),
    resource: notificationResourceSchema,
    usedBytes: z.number(),
  }),
  // An image app's tag names a newer image than the one it runs. What
  // happens next, deploying it or not, is on the app's page.
  z.object({
    digest: z.string(),
    image: z.string(),
    kind: z.literal("app.image-update"),
    resource: notificationResourceSchema,
  }),
  // An app finished deploying when someone else, or Kiln itself, started
  // it. `update` marks an image update, which says the app was updated. The
  // newest deployment replaces the App's last one, and `count` and `failures`
  // add in what the replaced one said while it was unread.
  z.object({
    count: z.number().int().positive().optional(),
    deploymentId: z.string(),
    failures: z.number().int().positive().optional(),
    kind: z.literal("app.deployed"),
    resource: notificationResourceSchema,
    status: z.enum(["succeeded", "failed"]),
    update: z.boolean(),
  }),
  // Grype found vulnerabilities the user hadn't heard of in what they can
  // fix, as one report for everything. A newer report replaces it, adding in
  // what this one said while it's unread. The Security page has the details.
  z.object({
    count: z.number().int().positive(),
    kind: z.literal("security.report"),
    knownExploited: z.number().int().nonnegative(),
    resources: z.array(notificationResourceSchema).min(1),
    severity: severitySchema,
  }),
  // A game server finished copying to a new one, as a duplicate or a move to
  // another Relay. A finished move offers to delete the server it left;
  // `sourceDeleting` marks one the move deletes itself after a final backup,
  // and `sourceDeleted` one that's gone.
  z.object({
    destination: notificationResourceSchema,
    error: z.string().optional(),
    kind: z.literal("server.migration"),
    migrationId: z.string(),
    mode: z.enum(["duplicate", "migrate"]),
    outcome: z.enum(["completed", "failed", "cancelled"]),
    source: notificationResourceSchema,
    sourceDeleted: z.boolean().optional(),
    sourceDeleting: z.boolean().optional(),
  }),
])

export type NotificationContent = z.infer<typeof notificationContentSchema>
export type NotificationKind = NotificationContent["kind"]

// Before reports, Kiln told of vulnerabilities in one notification per
// resource. Ones still stored read as a report of their resource.
const legacyVulnerabilitiesSchema = z
  .object({
    count: z.number().int().positive(),
    kind: z.literal("security.vulnerabilities"),
    knownExploited: z.number().int().nonnegative(),
    resource: notificationResourceSchema,
    severity: severitySchema,
  })
  .transform(
    ({ count, knownExploited, resource, severity }): NotificationContent => ({
      count,
      kind: "security.report",
      knownExploited,
      resources: [resource],
      severity,
    })
  )

// Relay updates had a notification of their own, one per Relay. Ones still
// stored read as a Kiln update of their Relay.
const legacyRelayUpdatedSchema = z
  .object({
    kind: z.literal("relay.updated"),
    previousVersion: z.string(),
    resource: notificationResourceSchema,
    version: z.string(),
  })
  .transform(({ previousVersion, resource, version }): NotificationContent => ({
    hearth: false,
    kind: "kiln.updated",
    previousVersion,
    relays: [resource],
    url: null,
    version,
  }))

/** A stored notification's content, including kinds a newer one replaced. */
export const storedNotificationContentSchema = z.union([
  notificationContentSchema,
  legacyVulnerabilitiesSchema,
  legacyRelayUpdatedSchema,
])

/**
 * The kinds a kind replaced, whose stored rows and settings carry over to it.
 */
export const formerNotificationKinds: Partial<
  Record<NotificationKind, ReadonlyArray<string>>
> = {
  "kiln.updated": ["relay.updated"],
  "security.report": ["security.vulnerabilities"],
}

export type NotificationResource = z.infer<typeof notificationResourceSchema>
export type InvitationOutcome = NonNullable<
  Extract<NotificationContent, { kind: "access.invited" }>["outcome"]
>

/** Names a resource in a person's notification settings. */
export function notificationResourceKey({
  id,
  relayId,
  type,
}: Pick<NotificationResource, "id" | "relayId" | "type">) {
  return `${type}:${relayId}:${id}`
}

export interface KilnNotification {
  content: NotificationContent
  createdAt: number
  id: string
  readAt: number | null
}

/** How many of the newest notifications a user's inbox holds. */
export const notificationHistoryLimit = 500
