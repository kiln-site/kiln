import { Resend } from "resend"
import type { RowDataPacket } from "mysql2/promise"
import { Clock, Duration, Effect, Schema } from "effect"
import { Activity, DurableClock } from "effect/workflow"

import { AccessInvitationEmail } from "@/emails/access-invitation-email"
import { kilnEmailAttachments } from "@/emails/kiln-email"
import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import { emailDeliveryConfig, kilnPublicUrl } from "@/lib/environment"
import { durableOperation, startDurableOperation } from "@/operations/durable"

// Emails an invitation to a game server, database, or Relay, as an operation
// on the invitation: sent once, tried again while it fails, and dropped once
// the invitation is answered, revoked, or expired. Its link names the
// invitation, never its token, so trying again later needs no secret.
// Platform invitations link by token, which Hearth keeps only hashed, so
// they're sent once as they're made (`server/access.ts`).

const SendOutcome = Schema.Literals(["failed", "sent", "skipped"])
type SendOutcome = typeof SendOutcome.Type

// The wait after each failed attempt, then this last one until the
// invitation expires, a week after it was made.
const RETRY_AFTER: ReadonlyArray<Duration.Input> = [
  "2 minutes",
  "10 minutes",
  "30 minutes",
  "2 hours",
]
const RETRY_AFTER_LAST: Duration.Input = "6 hours"

export const deliverInvitation = durableOperation({
  input: Schema.Struct({ invitationId: Schema.String }),
  kind: "invitation.deliver",
  run: ({ invitationId }) =>
    Effect.gen(function* () {
      for (let attempt = 1; ; attempt++) {
        const outcome = yield* Activity.make({
          name: `send/${attempt}`,
          success: SendOutcome,
          execute: sendInvitation(invitationId),
        })
        if (outcome !== "failed") return outcome
        yield* DurableClock.sleep({
          duration: RETRY_AFTER[attempt - 1] ?? RETRY_AFTER_LAST,
          name: `retry/${attempt}`,
        })
      }
    }),
  success: Schema.Literals(["sent", "skipped"]),
  version: 1,
})

/** Starts delivering invitations just made, each once. */
export const startInvitationDelivery = (
  invitationIds: ReadonlyArray<string>,
  actorId: string | null
) =>
  Effect.forEach(
    invitationIds,
    (invitationId) =>
      startDurableOperation(
        deliverInvitation,
        { invitationId },
        { actorId, idempotencyKey: invitationId }
      ),
    { discard: true }
  )

/**
 * Starts delivering every invitation still waiting for its email, as after
 * an upgrade from Hearth's old delivery worker. One already being delivered
 * is the same operation.
 */
export const resumeInvitationDelivery = Effect.fn("Invitations.resumeDelivery")(
  function* () {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const rows = yield* database.queryRows<RowDataPacket & { id: string }>(
      "invitations.pendingDelivery",
      `SELECT id FROM ${databaseTable("invitation")}
        WHERE access_type = 'scoped'
          AND delivery_status IN ('pending', 'failed')
          AND accepted_at IS NULL AND declined_at IS NULL
          AND revoked_at IS NULL AND expires_at > ?
        ORDER BY created_at`,
      [now]
    )
    yield* startInvitationDelivery(
      rows.map((row) => row.id),
      null
    )
  }
)

interface InvitationRow extends RowDataPacket {
  accepted_at: number | null
  declined_at: number | null
  delivery_status: string
  email: string
  expires_at: number
  inviter_name: string | null
  resource_name: string | null
  resource_type: "database" | "instance" | "relay" | null
  revoked_at: number | null
}

// One attempt: what it should send is read again each time, so an
// invitation answered or revoked meanwhile isn't sent.
const sendInvitation = (
  id: string
): Effect.Effect<SendOutcome, never, Database> =>
  Effect.gen(function* () {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const [invitation] = yield* database.queryRows<InvitationRow>(
      "invitations.delivery",
      `SELECT i.email, i.delivery_status, i.accepted_at, i.declined_at,
              i.revoked_at, i.expires_at, u.name AS inviter_name,
              COALESCE(s.display_name, s.source_name, d.name, r.name) AS resource_name,
              g.resource_type
         FROM ${databaseTable("invitation")} i
         JOIN ${databaseTable("access_grant")} g ON g.id = i.access_id
         JOIN ${databaseTable("relay")} r ON r.id = i.relay_id
         LEFT JOIN ${databaseTable("user")} u ON u.id = i.invited_by
         LEFT JOIN ${databaseTable("instance")} s
           ON s.relay_id = i.relay_id AND s.instance_id = i.instance_id
         LEFT JOIN ${databaseTable("database")} d ON d.database_id = i.database_id
        WHERE i.id = ?`,
      [id]
    )
    if (
      !invitation?.resource_type ||
      invitation.delivery_status === "sent" ||
      invitation.accepted_at !== null ||
      invitation.declined_at !== null ||
      invitation.revoked_at !== null ||
      Number(invitation.expires_at) <= now
    ) {
      return "skipped" as const
    }
    const delivery = emailDeliveryConfig()
    if (!delivery) {
      yield* database.execute(
        "invitations.delivery",
        `UPDATE ${databaseTable("invitation")}
            SET delivery_status = 'not_required' WHERE id = ?`,
        [id]
      )
      return "skipped" as const
    }
    const inviteUrl = new URL("/invite", kilnPublicUrl())
    inviteUrl.searchParams.set("id", id)
    const sent = yield* Effect.tryPromise(async () => {
      const { error } = await new Resend(delivery.apiKey).emails.send(
        {
          attachments: kilnEmailAttachments,
          from: delivery.from,
          react: AccessInvitationEmail({
            hearthUrl: kilnPublicUrl().toString(),
            inviteUrl: inviteUrl.toString(),
            inviterName: invitation.inviter_name ?? "Kiln",
            resourceName: invitation.resource_name ?? "your resource",
            role: "a member",
            scope: invitation.resource_type!,
          }),
          subject: `You've been invited to ${invitation.resource_name ?? "your resource"}`,
          to: [invitation.email],
        },
        // Resend sends one email per key, should an attempt whose answer
        // was lost be tried again.
        { idempotencyKey: `access-invitation/${id}` }
      )
      if (error) throw new Error(error.message || "Invitation delivery failed")
    }).pipe(
      Effect.as(true),
      Effect.catch(() => Effect.succeed(false))
    )
    // A failed email cannot undo access or identity. Only whether it went is
    // kept, not the provider's answer.
    if (sent) {
      yield* database.execute(
        "invitations.delivery",
        `UPDATE ${databaseTable("invitation")}
            SET delivery_status = 'sent', sent_at = ?,
                delivery_attempts = delivery_attempts + 1,
                delivery_last_error = NULL, delivery_next_attempt_at = NULL
          WHERE id = ?`,
        [now, id]
      )
      return "sent" as const
    }
    yield* database.execute(
      "invitations.delivery",
      `UPDATE ${databaseTable("invitation")}
          SET delivery_status = 'failed',
              delivery_attempts = delivery_attempts + 1,
              delivery_last_error = 'Email delivery failed',
              delivery_next_attempt_at = NULL
        WHERE id = ?`,
      [id]
    )
    return "failed" as const
  }).pipe(
    // Reading or recording the attempt failed: it's tried again later,
    // and Resend's key keeps a sent email from going twice.
    Effect.catch(() => Effect.succeed("failed" as const)),
    Effect.withSpan("Invitations.deliver", {
      attributes: { "invitation.id": id },
    })
  )
