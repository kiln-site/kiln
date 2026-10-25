import { z } from "zod"

const releaseUrlSchema = z.url({ protocol: /^https$/ })

const notificationResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  relayId: z.string(),
  type: z.enum(["relay", "instance", "database", "app"]),
})

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
  z.object({
    kind: z.literal("kiln.updated"),
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
  // past it, such as databases, warn this way.
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
  // it. `update` marks an image update, which says the app was updated.
  z.object({
    deploymentId: z.string(),
    kind: z.literal("app.deployed"),
    resource: notificationResourceSchema,
    status: z.enum(["succeeded", "failed"]),
    update: z.boolean(),
  }),
  // Grype found vulnerabilities its people hadn't heard of in what a
  // resource runs: for a Relay, its host or one of Kiln's services there,
  // which `component` names.
  z.object({
    component: z.string().nullable(),
    count: z.number().int().positive(),
    fixable: z.number().int().nonnegative(),
    kind: z.literal("security.vulnerabilities"),
    knownExploited: z.number().int().nonnegative(),
    resource: notificationResourceSchema,
    severity: z.enum(["critical", "high", "medium", "low", "negligible"]),
    top: z.object({
      fixedVersion: z.string().nullable(),
      id: z.string(),
      packageName: z.string(),
      packageVersion: z.string(),
    }),
  }),
])

export type NotificationContent = z.infer<typeof notificationContentSchema>
export type NotificationKind = NotificationContent["kind"]
export type NotificationResource = z.infer<typeof notificationResourceSchema>
export type InvitationOutcome = NonNullable<
  Extract<NotificationContent, { kind: "access.invited" }>["outcome"]
>

export interface KilnNotification {
  content: NotificationContent
  createdAt: number
  id: string
  readAt: number | null
}

/** How many of the newest notifications a user's inbox holds. */
export const notificationHistoryLimit = 500
