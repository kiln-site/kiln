import { Result } from "effect"

const INVITE_TOKEN_MIN_LENGTH = 32
const INVITATION_ID =
  /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu

/**
 * What an invitation link carries: the token of a link the inviter copied, or
 * the ID and key of the emailed one. Either lets a new person set up the
 * invited account.
 */
export type InvitationReference =
  | { token: string }
  | { id: string; key: string }

export function invitePath(token: string): string {
  return `/invite?token=${encodeURIComponent(token)}`
}

export function invitationReferencePath(
  reference: InvitationReference
): string {
  return "token" in reference
    ? invitePath(reference.token)
    : `/invite?id=${encodeURIComponent(reference.id)}&key=${encodeURIComponent(reference.key)}`
}

/** The invitation a sign-in page returns to, with whatever proof it had. */
export function invitationReferenceFromRedirect(
  redirectPath: string | undefined
): { token: string } | { id: string; key?: string } | null {
  if (!redirectPath?.startsWith("/invite?")) return null
  const search = Result.getOrNull(
    Result.try(() => new URL(redirectPath, "http://kiln.local").searchParams)
  )
  const token = search?.get("token")
  if (token && token.length >= INVITE_TOKEN_MIN_LENGTH) return { token }
  const id = search?.get("id")
  if (!id || !INVITATION_ID.test(id)) return null
  const key = search?.get("key")
  return key ? { id, key } : { id }
}

export function invitationDestination(invitation: {
  accessType: "platform_admin" | "relay_creator" | "scoped"
  databaseId: string | null
  instanceId: string | null
}): string {
  if (invitation.accessType !== "scoped") return "/infra/relays"
  if (invitation.databaseId) {
    return `/infra/databases?search=${encodeURIComponent(invitation.databaseId)}`
  }
  if (invitation.instanceId) {
    return `/server/${encodeURIComponent(invitation.instanceId)}/console`
  }
  return "/infra/servers"
}
