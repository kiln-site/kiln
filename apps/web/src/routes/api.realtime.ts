import { createFileRoute } from "@tanstack/react-router"

import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { getAuthenticatedRealtimeIdentityFromHeaders } from "@/lib/auth-session"
import { openAuthorizedRealtimeStream } from "@/server/realtime"

export const Route = createFileRoute("/api/realtime")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const identity = await getAuthenticatedRealtimeIdentityFromHeaders(
          request.headers
        )
        if (!identity) {
          return Response.json(
            {
              code: "authentication_required",
              error: "Authentication required.",
            },
            { status: 401 }
          )
        }
        if (!isAccountEnabled(identity.user) || !isAccountVerified(identity.user)) {
          return Response.json({ code: "account_ineligible", error: "Resource access unavailable." }, { status: 403 })
        }
        const body = await openAuthorizedRealtimeStream({
          sessionId: identity.sessionId,
          signal: request.signal,
          user: identity.user,
        })
        return new Response(body, {
          headers: {
            "Cache-Control": "no-store, no-transform",
            Connection: "keep-alive",
            "Content-Type": "text/event-stream; charset=utf-8",
            "X-Accel-Buffering": "no",
          },
        })
      },
    },
  },
})
