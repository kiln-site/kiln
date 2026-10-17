import { getRequest } from "@tanstack/react-start/server"
import { Effect, Result } from "effect"
import { logException } from "@workspace/telemetry"

import { runAppEffect } from "@/effect/runtime"
import { ExternalServiceError } from "@/effect/errors"
import type { PersistedRelay } from "@/lib/relay-registry"
import { databaseRpc } from "@/server/managed-database-access"

/** Live enrichment has a bounded fan-out and follows the caller's lifetime. */
export function readRelayInventories<T>(
  relays: ReadonlyArray<PersistedRelay>,
  operation: "app.list" | "database.list",
  decode: (value: unknown) => T
): Promise<
  Array<PromiseSettledResult<{ relay: PersistedRelay; inventory: T }>>
> {
  return runAppEffect(
    "Infra.inventory",
    Effect.forEach(
      relays,
      (relay) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({
            "relay.id": relay.id,
            "relay.operation": operation,
          })
          const response = yield* Effect.tryPromise({
            try: (signal) =>
              databaseRpc(relay, operation, {}, 15_000, undefined, signal),
            catch: (cause) =>
              ExternalServiceError.make({
                service: "Relay",
                message: "Relay inventory is unavailable",
                cause,
              }),
          })
          const inventory = yield* Effect.try({
            try: () => decode(response),
            catch: (cause) =>
              ExternalServiceError.make({
                service: "Relay",
                message: "Relay inventory is invalid",
                cause,
              }),
          })
          return { relay, inventory }
        }).pipe(
          Effect.withSpan("Infra.inventory.relay"),
          Effect.tapError((error) =>
            logException(error, {
              operation: "Infra.inventory.relay",
              attributes: {
                "relay.id": relay.id,
                "relay.operation": operation,
              },
            })
          ),
          Effect.result,
          Effect.map(
            (
              result
            ): PromiseSettledResult<{ relay: PersistedRelay; inventory: T }> =>
              Result.isSuccess(result)
                ? { status: "fulfilled", value: result.success }
                : { status: "rejected", reason: result.failure }
          )
        ),
      { concurrency: 4 }
    ),
    { signal: getRequest().signal }
  )
}
