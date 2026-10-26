import { parseCookies } from "better-auth/cookies"

import { auth } from "@/lib/auth"
import type { BrowserAccount } from "@/lib/browser-accounts"
import { resolveDisplayName } from "@/lib/display-name"

type DeviceSession = Awaited<
  ReturnType<typeof auth.api.listDeviceSessions>
>[number]

export class BrowserAccountMissingError extends Error {
  constructor() {
    super("That account is no longer signed in on this browser.")
  }
}

/** Accounts this browser holds a live session for, in a stable user ID order. */
export async function listBrowserAccounts(
  headers: Headers
): Promise<Array<Omit<BrowserAccount, "minecraftProfileId">>> {
  const [sessions, current] = await Promise.all([
    auth.api.listDeviceSessions({ headers }),
    auth.api.getSession({ headers }),
  ])
  await forgetEndedSessions(headers, sessions)
  const unremembered =
    current &&
    !sessions.some(({ session }) => session.id === current.session.id)
  if (unremembered) await rememberActiveBrowserAccount(headers)
  // An account signed in past the browser limit stays active without being
  // remembered for switching.
  const listed = unremembered ? [...sessions, current] : sessions
  return listed
    .sort((left, right) =>
      left.user.id < right.user.id ? -1 : left.user.id > right.user.id ? 1 : 0
    )
    .map(({ session, user }): Omit<BrowserAccount, "minecraftProfileId"> => ({
      active: session.id === current?.session.id,
      email: user.email,
      name: resolveDisplayName(user.name, user.email),
      sessionId: session.id,
      userId: user.id,
    }))
}

/**
 * Remembers the active session for switching before another account signs
 * in. Sessions from before multiple accounts lack that record.
 */
export async function rememberActiveBrowserAccount(
  headers: Headers
): Promise<void> {
  await auth.api.rememberActiveBrowserSession({ headers })
}

export async function switchBrowserAccount(
  headers: Headers,
  sessionId: string
): Promise<{ userId: string }> {
  const target = await findDeviceSession(headers, sessionId)
  await auth.api.setActiveSession({
    headers,
    body: { sessionToken: target.session.token },
  })
  return { userId: target.user.id }
}

/**
 * Signs one account out of this browser. When it was the active account, the
 * browser moves to another signed-in account, if any.
 */
export async function signOutBrowserAccount(
  headers: Headers,
  sessionId: string
): Promise<void> {
  const sessions = await auth.api.listDeviceSessions({ headers })
  const target = sessions.find(({ session }) => session.id === sessionId)
  if (target) {
    await auth.api.revokeDeviceSession({
      headers,
      body: { sessionToken: target.session.token },
    })
    return
  }
  const current = await auth.api.getSession({ headers })
  if (current?.session.id !== sessionId) throw new BrowserAccountMissingError()
  await auth.api.revokeSession({
    headers,
    body: { token: current.session.token },
  })
  await resumeBrowserAccount(headers)
}

/**
 * Makes another signed-in account active when the active session has ended,
 * such as after an abandoned two-factor sign-in or a revoked session.
 */
export async function resumeBrowserAccount(
  headers: Headers
): Promise<{ userId: string } | null> {
  const current = await auth.api.getSession({ headers })
  if (current) return { userId: current.user.id }
  const [next] = await auth.api.listDeviceSessions({ headers })
  if (!next) return null
  await auth.api.setActiveSession({
    headers,
    body: { sessionToken: next.session.token },
  })
  return { userId: next.user.id }
}

async function findDeviceSession(
  headers: Headers,
  sessionId: string
): Promise<DeviceSession> {
  const sessions = await auth.api.listDeviceSessions({ headers })
  const target = sessions.find(({ session }) => session.id === sessionId)
  if (!target) throw new BrowserAccountMissingError()
  return target
}

// Sessions revoked elsewhere or expired leave their cookies behind, and those
// count against the browser's account limit until removed.
async function forgetEndedSessions(
  headers: Headers,
  sessions: ReadonlyArray<DeviceSession>
) {
  const context = await auth.$context
  const { name, attributes } = context.authCookies.sessionToken
  const prefix = `${name}_multi-`.toLowerCase()
  const live = new Set(
    sessions.map(({ session }) => `${prefix}${session.token.toLowerCase()}`)
  )
  const ended = [...parseCookies(headers.get("cookie") ?? "").keys()].filter(
    (key) =>
      key.toLowerCase().startsWith(prefix) && !live.has(key.toLowerCase())
  )
  if (!ended.length) return
  const { deleteCookie } = await import("@tanstack/react-start/server")
  for (const key of ended) {
    deleteCookie(key, {
      domain: attributes.domain,
      path: attributes.path ?? "/",
      secure: attributes.secure,
    })
  }
}
