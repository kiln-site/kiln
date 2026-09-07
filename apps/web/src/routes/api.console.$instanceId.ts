import * as Sentry from "@sentry/tanstackstart-react"
import { createFileRoute } from "@tanstack/react-router"
import { relayIdSchema } from "@workspace/contracts"
import { Effect, Result } from "effect"

import { openHearthRelayConsoleStream } from "@/server/relay-console-proxy"
import { requireAuthenticatedIdentity } from "@/server/auth"

const encoder = new TextEncoder()

export const Route = createFileRoute("/api/console/$instanceId")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const userResult = await Effect.runPromise(
          Effect.tryPromise({
            try: requireAuthenticatedIdentity,
            catch: (cause) => cause,
          }).pipe(Effect.option)
        )
        const identity = userResult._tag === "Some" ? userResult.value : null
        if (!identity) {
          return Response.json(
            {
              code: "authentication_required",
              error: "Authentication required.",
            },
            { status: 401 }
          )
        }

        const url = new URL(request.url)
        const relayId = relayIdSchema.safeParse(url.searchParams.get("relayId"))
        const instanceId = decodePathSegment(url.pathname.split("/").at(-1))
        if (!relayId.success || !instanceId || instanceId.length > 64) {
          return Response.json(
            {
              code: "invalid_console_target",
              error: "The console target is invalid.",
            },
            { status: 400 }
          )
        }

        return Effect.runPromise(
          Effect.tryPromise({
            try: async () => {
              const lifecycle = new AbortController()
              const abort = () => lifecycle.abort()
              request.signal.addEventListener("abort", abort, { once: true })
              if (request.signal.aborted) abort()
              const iterator = openHearthRelayConsoleStream({
                instanceId,
                relayId: relayId.data,
                signal: lifecycle.signal,
                identity,
              })
              const first = await iterator.next()
              if (first.done)
                throw new Error("Relay console stream ended early")

              let firstPending = true
              let finished = false
              const finish = () => {
                if (finished) return
                finished = true
                request.signal.removeEventListener("abort", abort)
              }
              const body = new ReadableStream<Uint8Array>({
                pull: (controller) =>
                  Effect.runPromise(
                    Effect.tryPromise({
                      try: async () => {
                        if (firstPending) {
                          firstPending = false
                          controller.enqueue(encodeRecord(first.value))
                          return
                        }
                        const result = await iterator.next()
                        if (result.done) {
                          finish()
                          controller.close()
                          return
                        }
                        if (!lifecycle.signal.aborted) {
                          controller.enqueue(encodeRecord(result.value))
                        }
                      },
                      catch: (cause) => cause,
                    }).pipe(
                      Effect.catch((cause) =>
                        Effect.sync(() => {
                          finish()
                          if (lifecycle.signal.aborted) {
                            controller.close()
                            return
                          }
                          controller.enqueue(
                            encodeRecord({
                              code: "console_proxy_interrupted",
                              message:
                                cause instanceof Error
                                  ? cause.message
                                  : "The Hearth console proxy was interrupted.",
                              type: "proxy.error",
                            })
                          )
                          controller.close()
                        })
                      )
                    )
                  ),
                async cancel() {
                  lifecycle.abort()
                  finish()
                  await iterator.return(undefined)
                },
              })
              return new Response(body, {
                headers: {
                  "Cache-Control": "no-store, no-transform",
                  Connection: "keep-alive",
                  "Content-Type": "application/x-ndjson; charset=utf-8",
                  "X-Accel-Buffering": "no",
                },
              })
            },
            catch: (cause) => cause,
          }).pipe(
            Effect.match({
              onFailure: (cause) => {
                Sentry.captureException(cause, {
                  tags: {
                    "kiln.operation": "console.proxy.connect",
                    "kiln.relay_id": relayId.data,
                  },
                })
                return Response.json(
                  {
                    code: "console_proxy_failed",
                    error:
                      cause instanceof Error
                        ? cause.message
                        : "Hearth could not open the Relay console stream.",
                  },
                  { status: 502 }
                )
              },
              onSuccess: (response) => response,
            })
          )
        )
      },
    },
  },
})

function encodeRecord(value: unknown): Uint8Array {
  return encoder.encode(`${JSON.stringify(value)}\n`)
}

function decodePathSegment(value: string | undefined): string | null {
  return Result.getOrNull(Result.try(() => decodeURIComponent(value ?? "")))
}
