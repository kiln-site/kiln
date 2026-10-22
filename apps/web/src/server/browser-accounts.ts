import { createServerFn } from "@tanstack/react-start"
import { getRequestHeaders } from "@tanstack/react-start/server"
import { z } from "zod"

import {
  listBrowserAccounts,
  resumeBrowserAccount,
  signOutBrowserAccount,
  switchBrowserAccount,
} from "@/lib/browser-accounts.server"
import { requireAuthenticatedUser } from "@/server/auth"

const browserSessionInput = z.object({
  sessionId: z.string().min(1).max(128),
})

export const getBrowserAccounts = createServerFn({ method: "GET" }).handler(
  () => listBrowserAccounts(getRequestHeaders())
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
