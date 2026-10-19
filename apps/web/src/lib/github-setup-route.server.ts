import { recoverPromise } from "@/effect/promise"
import { reportAppError } from "@/effect/runtime"
import { isEligibleAccount } from "@/lib/account-policy"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { getAuthenticatedUserFromHeaders } from "@/lib/auth-session"

/**
 * Runs one step of connecting GitHub, which GitHub sends the browser back
 * to. The step returns where to go next; a failure lands on the Sync page
 * with its message.
 */
export async function githubSetupRedirect(
  request: Request,
  step: (user: AuthenticatedUser, url: URL) => Promise<string>
): Promise<Response> {
  const url = new URL(request.url)
  const user = await getAuthenticatedUserFromHeaders(request.headers)
  if (!user) {
    return redirect(
      `/?redirect=${encodeURIComponent(`${url.pathname}${url.search}`)}`
    )
  }
  if (!isEligibleAccount(user)) return redirect("/account-status")
  return recoverPromise(
    async () => redirect(await step(user, url)),
    (cause) => {
      reportAppError(cause, { operation: `github.setup${url.pathname}` })
      const message =
        cause instanceof Error && cause.message
          ? cause.message
          : "Kiln couldn't finish connecting GitHub"
      return redirect(
        `/infra/sources?githubError=${encodeURIComponent(message)}`
      )
    }
  )
}

function redirect(location: string): Response {
  return new Response(null, {
    headers: { "Cache-Control": "no-store", Location: location },
    status: 303,
  })
}
