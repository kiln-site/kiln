import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { listAccountSessionsEffect } from "@/effect/account-sessions"
import { runAppEffect } from "@/effect/runtime"
import { runOperationPromise } from "@/operations/operation"
import { revokeAccountSessionOperation } from "@/server/account-access.server"
import { requireVerifiedUser } from "@/server/auth"

export const getActiveSessions = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireVerifiedUser()
    return runAppEffect(
      "auth.sessions.list",
      listAccountSessionsEffect(user.id)
    )
  }
)

export const revokeActiveSession = createServerFn({ method: "POST" })
  .validator(
    z.object({
      sessionId: z.string().min(1).max(128),
    })
  )
  .handler(async ({ data }) => {
    await runOperationPromise(revokeAccountSessionOperation, data, {
      user: await requireVerifiedUser(),
    })
  })
