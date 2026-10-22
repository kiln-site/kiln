import type { BetterAuthPlugin } from "better-auth"
import { createAuthEndpoint, sessionMiddleware } from "better-auth/api"
import { parseCookies } from "better-auth/cookies"

import { maximumBrowserAccounts } from "@/lib/browser-accounts"

/**
 * Sessions signed in before multiple accounts existed carry no multi-session
 * cookie, so signing in to another account would forget them. This writes
 * that cookie for the active session, the same way the multi-session plugin
 * does at sign-in. It is served only to Kiln's server functions.
 */
export function browserAccountMemory() {
  return {
    id: "browser-account-memory",
    endpoints: {
      rememberActiveBrowserSession: createAuthEndpoint(
        "/multi-session/remember-active",
        { method: "POST", requireHeaders: true, use: [sessionMiddleware] },
        async (context) => {
          const { name, attributes } = context.context.authCookies.sessionToken
          const prefix = `${name}_multi-`.toLowerCase()
          const token = context.context.session.session.token
          const remembered = [
            ...parseCookies(context.headers?.get("cookie") ?? "").keys(),
          ]
            .map((key) => key.toLowerCase())
            .filter((key) => key.startsWith(prefix))
          if (remembered.includes(`${prefix}${token.toLowerCase()}`))
            return context.json({ remembered: true })
          if (remembered.length >= maximumBrowserAccounts)
            return context.json({ remembered: false })
          await context.setSignedCookie(
            `${name}_multi-${token.toLowerCase()}`,
            token,
            context.context.secret,
            attributes
          )
          return context.json({ remembered: true })
        }
      ),
    },
  } satisfies BetterAuthPlugin
}
