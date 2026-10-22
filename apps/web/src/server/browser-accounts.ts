import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { Effect } from "effect"
import { z } from "zod"

import { resolveMinecraftProfileEffect } from "@/effect/minecraft-profile"
import { runAppEffect } from "@/effect/runtime"
import {
  listBrowserAccounts,
  rememberActiveBrowserAccount,
  resumeBrowserAccount,
  signOutBrowserAccount,
  switchBrowserAccount,
} from "@/lib/browser-accounts.server"
import type { BrowserAccount } from "@/lib/browser-accounts"
import { getAuthenticatedUserFromHeaders } from "@/lib/auth-session"
import { requireAuthenticatedUser } from "@/server/auth"

const browserSessionInput = z.object({
  sessionId: z.string().min(1).max(128),
})

// Each account's head is resolved here because the profile query only knows
// the active session's user.
export const getBrowserAccounts = createServerFn({ method: "GET" }).handler(
  async (): Promise<Array<BrowserAccount>> => {
    const accounts = await listBrowserAccounts(getRequestHeaders())
    return runAppEffect(
      "browserAccounts.minecraftProfiles.resolve",
      Effect.forEach(
        accounts,
        (account) =>
          resolveMinecraftProfileEffect(account.name).pipe(
            Effect.map((profile) => profile?.id ?? null),
            Effect.catch(() => Effect.succeed(null)),
            Effect.map((minecraftProfileId) => ({
              ...account,
              minecraftProfileId,
            }))
          ),
        { concurrency: "unbounded" }
      )
    )
  }
)

export const switchBrowserAccountSession = createServerFn({ method: "POST" })
  .validator(browserSessionInput)
  .handler(({ data }) =>
    switchBrowserAccount(getRequestHeaders(), data.sessionId)
  )

export const signOutBrowserAccountSession = createServerFn({ method: "POST" })
  .validator(browserSessionInput)
  .handler(async ({ data }) => {
    await requireAuthenticatedUser()
    await signOutBrowserAccount(getRequestHeaders(), data.sessionId)
  })

export const resumeBrowserAccountSession = createServerFn({
  method: "POST",
}).handler(() => resumeBrowserAccount(getRequestHeaders()))

export const rememberActiveBrowserAccountSession = createServerFn({
  method: "POST",
}).handler(async () => {
  await requireAuthenticatedUser()
  await rememberActiveBrowserAccount(getRequestHeaders())
})

// Tabs that may render a stale account ask this, so it skips the rendered
// account check that the session helpers apply.
export const getActiveBrowserAccountId = createServerFn({
  method: "GET",
}).handler(
  async () =>
    (await getAuthenticatedUserFromHeaders(getRequestHeaders()))?.id ?? null
)
