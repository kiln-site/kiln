import { Result } from "effect"

const INVITE_TOKEN_MIN_LENGTH = 32

export function invitePath(token: string): string {
  return `/invite?token=${encodeURIComponent(token)}`
}

export function inviteTokenFromRedirect(
  redirectPath: string | undefined
): string | null {
  if (!redirectPath?.startsWith("/invite?")) return null
  const token = Result.getOrNull(
    Result.try(() =>
      new URL(redirectPath, "http://kiln.local").searchParams.get("token")
    )
  )
  if (!token || token.length < INVITE_TOKEN_MIN_LENGTH) return null
  return token
}

export function invitationReferenceFromRedirect(
  redirectPath: string | undefined
): { token: string } | { id: string } | null {
  const token = inviteTokenFromRedirect(redirectPath)
  if (token) return { token }
  if (!redirectPath?.startsWith("/invite?")) return null
  const parsed = Result.getOrNull(
    Result.try(() => new URL(redirectPath, "https://kiln.invalid"))
  )
  const id = parsed?.searchParams.get("id")
  return id &&
    /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/iu.test(id)
    ? { id }
    : null
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
