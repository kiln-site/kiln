import { Effect } from "effect"
import { createFileRoute } from "@tanstack/react-router"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { getAuthenticatedRealtimeIdentityFromHeaders } from "@/lib/auth-session"
import { subscribeRealtimeChanges } from "@/lib/realtime-source.server"

// This stream carries only the current account's eligibility. Disabled and
// unverified accounts never retain a resource subscription to learn they changed.
export const Route = createFileRoute("/api/account-status")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const identity = await getAuthenticatedRealtimeIdentityFromHeaders(
          request.headers
        )
        if (!identity) return new Response(null, { status: 401 })
        const sessionId = identity.sessionId
        const userId = identity.user.id
        let cleanup = () => {}
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const encoder = new TextEncoder()
            let closed = false
            let checking = false
            let previous = ""
            function close() {
              if (closed) return
              closed = true
              cleanup()
              controller.close()
            }
            async function refresh() {
              if (closed || checking) return
              checking = true
              await Effect.runPromise(
                Effect.tryPromise({
                  try: async () => {
                    const current =
                      await getAuthenticatedRealtimeIdentityFromHeaders(
                        request.headers
                      )
                    if (!closed) {
                      const value = JSON.stringify(
                        current && current.sessionId === sessionId
                          ? {
                              authenticated: true,
                              enabled: isAccountEnabled(current.user),
                              verified: isAccountVerified(current.user),
                            }
                          : {
                              authenticated: false,
                              enabled: false,
                              verified: false,
                            }
                      )
                      if (value !== previous) {
                        previous = value
                        controller.enqueue(encoder.encode(`data: ${value}\n\n`))
                      } else
                        controller.enqueue(encoder.encode(": keepalive\n\n"))
                      if (!current || current.sessionId !== sessionId) close()
                    }
                  },
                  catch: (cause) => cause,
                }).pipe(
                  Effect.catch(() => Effect.sync(close)),
                  Effect.ensuring(
                    Effect.sync(() => {
                      checking = false
                    })
                  )
                )
              )
            }
            const unsubscribe = subscribeRealtimeChanges((event) => {
              if (
                (event.type === "access.changed" &&
                  event.userIds.includes(userId)) ||
                (event.type === "session.revoked" &&
                  event.sessionIds.includes(sessionId))
              )
                void refresh()
            })
            const timer = setInterval(() => void refresh(), 20_000)
            cleanup = () => {
              closed = true
              clearInterval(timer)
              unsubscribe()
              request.signal.removeEventListener("abort", close)
            }
            request.signal.addEventListener("abort", close, { once: true })
            if (request.signal.aborted) close()
            else void refresh()
          },
          cancel() {
            cleanup()
          },
        })
        return new Response(stream, {
          headers: {
            "Content-Type": "text/event-stream; charset=utf-8",
            "Cache-Control": "no-store, no-transform",
            "X-Accel-Buffering": "no",
          },
        })
      },
    },
  },
})
