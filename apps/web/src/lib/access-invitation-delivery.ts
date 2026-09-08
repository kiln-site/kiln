import { Resend } from "resend"
import type { RowDataPacket } from "mysql2/promise"
import { Effect, Schedule } from "effect"
import { AccessInvitationEmail } from "@/emails/access-invitation-email"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { emailDeliveryConfig, kilnPublicUrl } from "@/lib/environment"
import { forkAppEffect } from "@/effect/runtime"

interface InvitationDelivery {
  id: string
  email: string
  inviteUrl: string
  inviterName: string
  resourceName: string
  scope: "relay" | "instance" | "database"
}

/** Delivery links identify an invitation; they never establish identity or verification. */
export async function deliverAccessInvitations(
  invitations: Array<InvitationDelivery>
) {
  const delivery = emailDeliveryConfig()
  for (const invitation of invitations) {
    if (!delivery) {
      await databasePool.execute(
        `UPDATE ${databaseTable("invitation")} SET delivery_status = 'not_required' WHERE id = ?`,
        [invitation.id]
      )
      continue
    }
    await Effect.runPromise(
      Effect.tryPromise(async () => {
        const resend = new Resend(delivery.apiKey)
        const inviteUrl = new URL("/invite", kilnPublicUrl())
        inviteUrl.searchParams.set("id", invitation.id)
        const { error } = await resend.emails.send(
          {
            from: delivery.from,
            to: [invitation.email],
            subject: `You've been invited to ${invitation.resourceName}`,
            react: AccessInvitationEmail({
              ...invitation,
              inviteUrl: inviteUrl.toString(),
              role: "a member",
            }),
          },
          { idempotencyKey: `access-invitation/${invitation.id}` }
        )
        if (error)
          throw new Error(error.message || "Invitation delivery failed")
        await databasePool.execute(
          `UPDATE ${databaseTable("invitation")} SET delivery_status = 'sent', sent_at = CURRENT_TIMESTAMP(3), delivery_attempts = delivery_attempts + 1, delivery_last_error = NULL, delivery_next_attempt_at = NULL WHERE id = ?`,
          [invitation.id]
        )
      }).pipe(
        Effect.catch(() =>
          Effect.tryPromise(async () => {
            // A failed email cannot undo access or identity. Persist retry state without tokens/provider payloads.
            await databasePool.execute(
              `UPDATE ${databaseTable("invitation")} SET delivery_status = 'failed', delivery_attempts = delivery_attempts + 1, delivery_last_error = 'Email delivery failed', delivery_next_attempt_at = DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 5 MINUTE) WHERE id = ?`,
              [invitation.id]
            )
          })
        )
      )
    )
  }
}

let started = false
export function startAccessInvitationDelivery() {
  if (started) return
  started = true
  forkAppEffect(
    "access.invitation.delivery",
    Effect.tryPromise(async () => {
      if (!emailDeliveryConfig()) return
      interface PendingRow extends RowDataPacket {
        id: string
        email: string
        inviter_name: string
        resource_name: string
        resource_type: InvitationDelivery["scope"]
      }
      const [rows] = await databasePool.query<
        Array<PendingRow>
      >(`SELECT i.id, i.email, u.name AS inviter_name, COALESCE(s.display_name, s.source_name, d.name, r.name) AS resource_name, g.resource_type
      FROM ${databaseTable("invitation")} i JOIN ${databaseTable("access_grant")} g ON g.id = i.access_id
      JOIN ${databaseTable("relay")} r ON r.id = i.relay_id
      LEFT JOIN ${databaseTable("user")} u ON u.id = i.invited_by
      LEFT JOIN ${databaseTable("instance")} s ON s.relay_id = i.relay_id AND s.instance_id = i.instance_id
      LEFT JOIN ${databaseTable("database")} d ON d.database_id = i.database_id
      WHERE i.delivery_status IN ('pending', 'failed') AND (i.delivery_next_attempt_at IS NULL OR i.delivery_next_attempt_at <= CURRENT_TIMESTAMP(3))
      AND i.accepted_at IS NULL AND i.declined_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP(3)
      ORDER BY i.created_at LIMIT 25`)
      await deliverAccessInvitations(
        rows.map((row) => ({
          id: row.id,
          email: row.email,
          inviterName: row.inviter_name ?? "Kiln",
          resourceName: row.resource_name ?? "your resource",
          scope: row.resource_type,
          inviteUrl: "",
        }))
      )
    }).pipe(
      Effect.catch(() => Effect.void),
      Effect.repeat(Schedule.spaced("1 minute"))
    )
  )
}
