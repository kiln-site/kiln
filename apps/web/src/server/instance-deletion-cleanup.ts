import { Effect } from "effect"

import { setInstanceDomainOptOutEffect } from "@/effect/domains"
import { reportAppError } from "@/effect/runtime"
import { deleteInstanceAccessEffect } from "@/lib/access-control"
import { removeDeletedInstanceEffect } from "@/lib/instance-registry"
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
  // A removed vanity domain stays removed until the server itself is gone.
  yield* postDeleteCleanupStep(
    "domains.optOut.clear",
    relayId,
    instanceId,
    setInstanceDomainOptOutEffect(relayId, instanceId, false)
  )
  // The Relay has removed the server, so its directory record goes too.
  // Live snapshots never remove records on their own.
  yield* postDeleteCleanupStep(
    "instances.registry.unregister",
    relayId,
    instanceId,
    removeDeletedInstanceEffect(relayId, instanceId)
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
