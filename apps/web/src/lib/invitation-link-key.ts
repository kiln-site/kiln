import { createHmac, timingSafeEqual } from "node:crypto"

import { betterAuthSecrets } from "@/lib/environment"

// The keys in a resource invitation's links, derived from its ID rather than
// stored, so its email can be sent again after a failure without keeping a
// secret around. Each lets a new person set up the invited account:
//
// - `email`: only the invitation's email carries it, so opening it proves
//   the recipient reads that mailbox.
// - `share`: the link an inviter copies from the access table. It proves
//   only that the inviter chose whom to give it to.
export type InvitationLinkPurpose = "email" | "share"

const purposes: ReadonlyArray<InvitationLinkPurpose> = ["email", "share"]

function sign(
  secret: string,
  purpose: InvitationLinkPurpose,
  invitationId: string
): string {
  return createHmac("sha256", secret)
    .update(`kiln:invitation-${purpose}:${invitationId}`)
    .digest("base64url")
}

export function invitationLinkKey(
  invitationId: string,
  purpose: InvitationLinkPurpose
): string {
  return sign(betterAuthSecrets()[0]!.value, purpose, invitationId)
}

/** Which of this invitation's links `key` belongs to, under any current secret. */
export function invitationLinkPurpose(
  invitationId: string,
  key: string
): InvitationLinkPurpose | null {
  const presented = Buffer.from(key)
  const secrets = betterAuthSecrets()
  return (
    purposes.find((purpose) =>
      secrets.some((secret) => {
        const expected = Buffer.from(sign(secret.value, purpose, invitationId))
        return (
          expected.length === presented.length &&
          timingSafeEqual(expected, presented)
        )
      })
    ) ?? null
  )
}
