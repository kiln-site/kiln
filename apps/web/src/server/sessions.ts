import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import {
  listAccountSessionsEffect,
  revokeAccountSessionEffect,
} from "@/effect/account-sessions"
import { runAppEffect } from "@/effect/runtime"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { requireAuthenticatedUser } from "@/server/auth"

export const getActiveSessions = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
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
    const user = await requireAuthenticatedUser()
    const revisionChange = await runAppEffect(
      "auth.sessions.revoke",
      revokeAccountSessionEffect(user.id, data.sessionId)
    )
    if (revisionChange) {
      const { wakeAuthorizationDelivery } =
        await import("@/lib/authorization-delivery")
      for (const relayId of revisionChange.relayIds) {
        wakeAuthorizationDelivery(relayId)
      }
    }
    publishRealtimeChange({
      sessionIds: [data.sessionId],
      type: "session.revoked",
    })
  })
