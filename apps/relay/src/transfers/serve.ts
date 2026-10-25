/**
 * Serves one direct transfer: a span joined to the caller's trace, the
 * transfer's permit and other resources scoped to it, metrics for how it
 * ended, and one way of answering a refusal or failure. Every transfer
 * route runs through here.
 */
import type { IncomingMessage, ServerResponse } from "node:http"
import { Clock, Effect, Metric, Scope } from "effect"
import type { Tracer } from "effect"

import { reportRelayError, traceRelayEffect } from "../effect/runtime.js"
import {
  sendJson,
  TransferRejected,
  transferFailureMessage,
  type SentBody,
} from "./http.js"

/** The kinds of transfer, a small fixed set for metric attributes. */
export type TransferRoute = "backup.download" | "browser.file" | "peer.transfer"

/** What a transfer moved, once it ended. */
export interface TransferResult extends SentBody {
  readonly direction: "received" | "sent"
}

const requests = Metric.counter("relay.transfer.requests", {
  description: "Direct transfer requests the Relay finished, by how they ended",
  attributes: { unit: "{request}" },
  incremental: true,
})

const transferredBytes = Metric.counter("relay.transfer.bytes", {
  description: "Bytes direct transfers sent or received",
  attributes: { unit: "By" },
  incremental: true,
})

const duration = Metric.histogram("relay.transfer.duration", {
  description: "Time a direct transfer took, from its request to its end",
  attributes: { unit: "s" },
  boundaries: [0.05, 0.25, 1, 5, 15, 60, 300, 900, 3600, 14400],
})

type Outcome = "aborted" | "completed" | "failed" | "rejected"

export interface ServeTransferInput {
  readonly route: TransferRoute
  readonly request: IncomingMessage
  readonly response: ServerResponse
  /** The caller's span, from its `traceparent`, when it sent one. */
  readonly parent?: Tracer.AnySpan | undefined
  readonly attributes?: Readonly<Record<string, unknown>>
  /** Headers every answer carries, such as a browser origin's CORS. */
  readonly headers?: () => Readonly<Record<string, string>>
  /**
   * The transfer. It answers the request itself and ends with what it
   * moved, or with nothing for an answer that moved no file, such as a
   * preflight or a lookup that found nothing.
   */
  readonly program: Effect.Effect<TransferResult | void, unknown, Scope.Scope>
}

export function serveTransfer(input: ServeTransferInput): Effect.Effect<void> {
  const { request, response, route } = input
  const operation = `relay.transfer.${route}`
  return Effect.gen(function* () {
    const startedAt = yield* Clock.currentTimeMillis
    const outcome: Outcome = yield* Effect.scoped(input.program).pipe(
      Effect.flatMap((result) => {
        if (!result) return Effect.succeed<Outcome>("completed")
        const ended: Outcome = result.completed ? "completed" : "aborted"
        return Effect.all(
          [
            Effect.annotateCurrentSpan({
              "kiln.transfer.bytes": result.bytes,
              "kiln.transfer.direction": result.direction,
            }),
            Metric.update(
              Metric.withAttributes(transferredBytes, {
                "kiln.transfer.route": route,
                "kiln.transfer.direction": result.direction,
              }),
              result.bytes
            ),
          ],
          { discard: true }
        ).pipe(Effect.as(ended))
      }),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          const rejected = cause instanceof TransferRejected
          const status = rejected ? cause.status : 400
          yield* Effect.annotateCurrentSpan({
            "http.response.status_code": status,
          })
          if (!rejected) {
            reportRelayError(cause, { operation })
          }
          if (response.headersSent) {
            response.destroy(cause instanceof Error ? cause : undefined)
          } else {
            sendJson(
              response,
              status,
              { error: transferFailureMessage(cause) },
              input.headers?.()
            )
          }
          return rejected ? ("rejected" as const) : ("failed" as const)
        })
      )
    )
    const endedAt = yield* Clock.currentTimeMillis
    yield* Effect.all(
      [
        Effect.annotateCurrentSpan({ "kiln.transfer.outcome": outcome }),
        Metric.update(
          Metric.withAttributes(requests, {
            "kiln.transfer.route": route,
            "kiln.transfer.outcome": outcome,
          }),
          1
        ),
        Metric.update(
          Metric.withAttributes(duration, { "kiln.transfer.route": route }),
          (endedAt - startedAt) / 1000
        ),
      ],
      { discard: true }
    )
  }).pipe(
    (effect) =>
      traceRelayEffect(
        "RelayTransfer.serve",
        effect,
        {
          "kiln.transfer.route": route,
          "http.request.method": request.method ?? "GET",
          ...input.attributes,
        },
        input.parent
      ),
    // A defect in a route is still answered rather than left hanging.
    Effect.catchCause((cause) =>
      Effect.sync(() => {
        reportRelayError(cause, { operation })
        if (response.headersSent) response.destroy()
        else sendJson(response, 500, { error: "File transfer failed" })
      })
    )
  )
}
