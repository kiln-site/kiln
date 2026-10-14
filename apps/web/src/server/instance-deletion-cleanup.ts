import { Effect } from "effect"

import { reportAppError } from "@/effect/runtime"
import { deleteInstanceAccessEffect } from "@/lib/access-control"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"

export const finalizeInstanceDeletionEffect = Effect.fn(
  "instances.delete.finalize"
)(function* (relayId: string, instanceId: string) {
  yield* postDeleteCleanupStep(
    "relay.snapshot.invalidate",
    relayId,
    instanceId,
    invalidateRelayCache(relayCachePolicy.snapshot(relayId))
  )
  yield* postDeleteCleanupStep(
    "access.deleteInstance",
    relayId,
    instanceId,
    deleteInstanceAccessEffect(relayId, instanceId)
  )
})

function postDeleteCleanupStep<TError, TRequirements>(
  operation: string,
  relayId: string,
  instanceId: string,
  cleanup: Effect.Effect<unknown, TError, TRequirements>
) {
  return cleanup.pipe(
    Effect.asVoid,
    Effect.catch((error) =>
      reportPostDeleteCleanupFailureEffect(
        operation,
        relayId,
        instanceId,
        error
      )
    )
  )
}

const reportPostDeleteCleanupFailureEffect = Effect.fn(
  "instances.delete.reportCleanupFailure"
)(function* (
  operation: string,
  relayId: string,
  instanceId: string,
  error: unknown
) {
  yield* Effect.sync(() =>
    reportAppError(error, {
      operation,
      attributes: {
        "kiln.instance_id": instanceId,
        "kiln.relay_id": relayId,
      },
    })
  )
  yield* Effect.logWarning(
    "Post-delete Hearth cleanup failed after Relay removed the server",
    {
      error: error instanceof Error ? error.message : String(error),
      instanceId,
      operation,
      relayId,
    }
  )
})
