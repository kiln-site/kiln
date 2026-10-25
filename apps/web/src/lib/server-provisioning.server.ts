/**
 * Provisions a game server on a Relay: reserves it in Hearth, prepares it on
 * the Relay, registers it, and claims the Relay's provisioning job, undoing
 * each step if a later one fails. Retrying with the same idempotency key
 * resumes the same server. Creating one from the dialog and copying one
 * both go through here.
 */
import { Effect } from "effect"
import { z } from "zod"
import {
  relayCreateInstanceSchema,
  relayInstanceSchema,
} from "@workspace/contracts"

import { promiseEffect } from "@/effect/promise"
import { forkAppEffect } from "@/effect/runtime"
import {
  registerPreparedInstance,
  reservePreparedInstance,
  unregisterInstance,
} from "@/lib/instance-registry"
import {
  claimPreparedProvisioning,
  compensatePreparedProvisioning,
  provisioningInstanceId,
} from "@/lib/provisioning.server"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import type { PersistedRelay } from "@/lib/relay-registry"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { requestRelay } from "@/server/bricks.server"

const cancelProvisioningResultSchema = z.object({
  cancelled: z.boolean(),
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
})

export async function provisionServer(input: {
  readonly relay: PersistedRelay
  readonly create: z.output<typeof relayCreateInstanceSchema>
  readonly idempotencyKey: string
  /** Who owns the new server. */
  readonly ownerId: string
  /** On whose behalf the Relay is asked, for its audit. */
  readonly requestedBy: string
}): Promise<z.output<typeof relayInstanceSchema>> {
  const { idempotencyKey, ownerId, relay, requestedBy } = input
  const instanceId = provisioningInstanceId(idempotencyKey)
  const cancelProvisioning = () =>
    requestRelay(
      relay,
      `/v1/instances/${encodeURIComponent(instanceId)}/provision`,
      { method: "DELETE" },
      30_000,
      requestedBy
    ).then((result) => cancelProvisioningResultSchema.parse(result).cancelled)
  const unregister = () => unregisterInstance(relay.id, instanceId)
  await reservePreparedInstance(relay.id, { id: instanceId }, ownerId)
  const instance = await Effect.runPromise(
    promiseEffect(() =>
      requestRelay(
        relay,
        "/v1/instance-provisioning",
        {
          method: "POST",
          body: JSON.stringify({ ...input.create, idempotencyKey, instanceId }),
        },
        30_000,
        requestedBy
      )
    ).pipe(
      Effect.map(relayInstanceSchema.parse),
      Effect.tapError(() =>
        compensatePreparedProvisioning(cancelProvisioning, unregister)
      )
    )
  )
  await Effect.runPromise(
    promiseEffect(() =>
      registerPreparedInstance(relay.id, instance, ownerId)
    ).pipe(
      Effect.tapError(() =>
        compensatePreparedProvisioning(cancelProvisioning, unregister)
      )
    )
  )
  await claimPreparedProvisioning({
    cancel: cancelProvisioning,
    unconfirmed: "Retry the unchanged request to resume the same server.",
    claim: () =>
      requestRelay(
        relay,
        `/v1/instances/${encodeURIComponent(instance.id)}/provision`,
        { method: "POST" },
        30_000,
        requestedBy
      ),
    unregister,
  })
  forkAppEffect(
    "relay.snapshot.invalidate",
    invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
  )
  publishRealtimeChange({
    directoryChanged: true,
    instance,
    relayId: relay.id,
    type: "instance.upsert",
  })
  return instance
}
