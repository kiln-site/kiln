import type { BetterAuthPlugin } from "better-auth"
import {
  APIError,
  createAuthEndpoint,
  sensitiveSessionMiddleware,
} from "better-auth/api"
import { setSessionCookie } from "better-auth/cookies"
import * as z from "zod"

export function passwordConfirmation() {
  return {
    id: "password-confirmation",
    endpoints: {
      confirmPassword: createAuthEndpoint(
        "/password-confirmation/confirm",
        {
          method: "POST",
          body: z.object({ password: z.string().min(1) }),
          use: [sensitiveSessionMiddleware],
        },
        async (context) => {
          const currentSession = context.context.session
          await context.context.password.checkPassword(
            currentSession.user.id,
            context
          )

          const freshSession =
            await context.context.internalAdapter.createSession(
              currentSession.user.id,
              false,
              currentSession.session
            )
          if (!freshSession) {
            throw new APIError("INTERNAL_SERVER_ERROR", {
              message: "Could not refresh the session",
            })
          }

          await setSessionCookie(context, {
            session: freshSession,
            user: currentSession.user,
          })
          await context.context.internalAdapter.deleteSession(
            currentSession.session.token
          )

          return context.json({ status: true })
        }
      ),
    },
  } satisfies BetterAuthPlugin
}
