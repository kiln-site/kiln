import * as React from "react"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { cliMobileChallengeSchema } from "@workspace/contracts"
import { LoaderCircle } from "lucide-react"
import { z } from "zod"

import { Button } from "@workspace/ui/components/button"

import { AuthBrand, AuthPageShell } from "@/components/auth-page-shell"
import { recoverPromise } from "@/effect/promise"
import { pageTitle } from "@/lib/page-title"
import { disableDevelopmentBypass, getAuthState } from "@/server/auth"
import { authorizeMobileSignIn } from "@/server/cli"

// A sign-in only ever returns to the Kiln app, or its development build.
const APP_REDIRECTS = ["kiln://auth", "kiln-dev://auth"] as const

export const Route = createFileRoute("/mobile/sign-in")({
  validateSearch: z.object({
    challenge: cliMobileChallengeSchema,
    name: z.string().trim().min(1).max(120).default("Kiln app"),
    redirect: z.enum(APP_REDIRECTS).default("kiln://auth"),
    state: z.string().min(16).max(128),
  }),
  beforeLoad: async ({ location }) => {
    const state = await getAuthState()
    if (!state.user) {
      throw redirect({ to: "/", search: { redirect: location.href } })
    }
    return { user: state.user }
  },
  head: () => ({ meta: [{ title: pageTitle("Sign in to the Kiln app") }] }),
  component: MobileSignInRoute,
})

function MobileSignInRoute() {
  const { user } = Route.useRouteContext()
  const search = Route.useSearch()
  const [error, setError] = React.useState<string | null>(null)
  const started = React.useRef(false)

  React.useEffect(() => {
    if (user.isDevelopmentBypass || started.current) return
    started.current = true
    void recoverPromise(
      async () => {
        const { code } = await authorizeMobileSignIn({
          data: { challenge: search.challenge, name: search.name },
        })
        const target = new URL(search.redirect)
        target.searchParams.set("code", code)
        target.searchParams.set("state", search.state)
        window.location.replace(target.toString())
      },
      (cause) =>
        setError(cause instanceof Error ? cause.message : "Couldn't sign in.")
    )
  }, [
    search.challenge,
    search.name,
    search.redirect,
    search.state,
    user.isDevelopmentBypass,
  ])

  async function switchToAccount() {
    await disableDevelopmentBypass()
    window.location.reload()
  }

  return (
    <AuthPageShell>
      <div className="grid gap-8 text-center">
        <AuthBrand />
        {user.isDevelopmentBypass ? (
          <div className="grid gap-4">
            <p className="text-sm leading-relaxed text-muted-foreground">
              The development shortcut has no account to sign the app in with.
              Sign in with your account instead.
            </p>
            <Button onClick={() => void switchToAccount()}>
              Sign in with an account
            </Button>
          </div>
        ) : error ? (
          <div className="grid gap-4">
            <p className="text-sm leading-relaxed text-destructive">{error}</p>
            <p className="text-sm text-muted-foreground">
              Close this window and sign in from the app again.
            </p>
          </div>
        ) : (
          <p className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
            <LoaderCircle className="size-4 animate-spin" />
            Signing in to the Kiln app…
          </p>
        )}
      </div>
    </AuthPageShell>
  )
}
