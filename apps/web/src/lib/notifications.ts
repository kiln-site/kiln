import { z } from "zod"

const releaseUrlSchema = z.url({ protocol: /^https$/ })

const notificationResourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  relayId: z.string(),
  type: z.enum(["relay", "instance", "database"]),
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
