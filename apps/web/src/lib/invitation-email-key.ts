import { createHmac, timingSafeEqual } from "node:crypto"

import { betterAuthSecrets } from "@/lib/environment"

// The key in a resource invitation's emailed link. Only that email carries
// it, so opening the link proves the recipient reads that mailbox. Hearth
// derives it from the invitation's ID instead of storing it, which lets the
// email be sent again after a failure without keeping a secret around.

function sign(secret: string, invitationId: string): string {
  return createHmac("sha256", secret)
    .update(`kiln:invitation-email:${invitationId}`)
    .digest("base64url")
}

export function invitationEmailKey(invitationId: string): string {
  return sign(betterAuthSecrets()[0]!.value, invitationId)
}

/** Whether `key` is this invitation's emailed key under any current secret. */
export function isInvitationEmailKey(
  invitationId: string,
  key: string
): boolean {
  const presented = Buffer.from(key)
  return betterAuthSecrets().some((secret) => {
    const expected = Buffer.from(sign(secret.value, invitationId))
    return (
      expected.length === presented.length &&
      timingSafeEqual(expected, presented)
    )
  })
}
