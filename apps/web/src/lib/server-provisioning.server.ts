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
  instanceIdSchema,
  relayCreateServerSchema,
  relayServerSchema,
} from "@workspace/contracts"

import { promiseEffect } from "@/effect/promise"
import { forkAppEffect } from "@/effect/runtime"
import {
  registerPreparedServer,
  reservePreparedServer,
  unregisterServer,
} from "@/lib/server-registry"
import {
  claimPreparedProvisioning,
  compensatePreparedProvisioning,
} from "@/lib/provisioning.server"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import type { PersistedRelay } from "@/lib/relay-registry"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { beginServerInstall } from "@/lib/server-deployments.server"
import { deleteInstanceDeploymentsEffect } from "@/effect/app-deployments"
import { runAppEffect } from "@/effect/runtime"
import { requestRelay } from "@/server/bricks.server"

const cancelProvisioningResultSchema = z.object({
  cancelled: z.boolean(),
  instanceId: instanceIdSchema,
})

export async function provisionServer(input: {
  readonly relay: PersistedRelay
  readonly create: z.output<typeof relayCreateServerSchema>
  readonly idempotencyKey: string
  /** Reserved for the request (`reserveServerInstanceIdEffect`). */
  readonly instanceId: string
  /** Who owns the new server. */
  readonly ownerId: string
  /** On whose behalf the Relay is asked, for its audit. */
  readonly requestedBy: string
}): Promise<z.output<typeof relayServerSchema>> {
  const { idempotencyKey, instanceId, ownerId, relay, requestedBy } = input
  const cancelProvisioning = () =>
    requestRelay(
      relay,
      `/v1/instances/${encodeURIComponent(instanceId)}/provision`,
      { method: "DELETE" },
      30_000,
      requestedBy
    ).then((result) => cancelProvisioningResultSchema.parse(result).cancelled)
  const unregister = () => unregisterServer(relay.id, instanceId)
  await reservePreparedServer(relay.id, { id: instanceId }, ownerId)
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
      Effect.map(relayServerSchema.parse),
      Effect.tapError(() =>
        compensatePreparedProvisioning(cancelProvisioning, unregister)
      )
    )
  )
  await Effect.runPromise(
    promiseEffect(() =>
      registerPreparedServer(relay.id, instance, ownerId)
    ).pipe(
      Effect.tapError(() =>
        compensatePreparedProvisioning(cancelProvisioning, unregister)
      )
    )
  )
  // Its install is a deployment, recorded before the Relay can start it;
  // the Relay keeps its log under the same ID.
  const deploymentId = await beginServerInstall({
    brickId:
      input.create.recipeDefinition?.metadata.id ?? instance.brickId ?? null,
    brickName: input.create.recipeDefinition?.metadata.name ?? null,
    instanceId: instance.id,
    relayId: relay.id,
    userId: requestedBy,
  })
  await claimPreparedProvisioning({
    cancel: cancelProvisioning,
    unconfirmed: "Retry the unchanged request to resume the same server.",
    claim: () =>
      requestRelay(
        relay,
        `/v1/instances/${encodeURIComponent(instance.id)}/provision`,
        { method: "POST", body: JSON.stringify({ deploymentId }) },
        30_000,
        requestedBy
      ),
    // A server that never was has no deployments.
    unregister: async () => {
      await unregister()
      await runAppEffect(
        "deployments.deleteInstance",
        deleteInstanceDeploymentsEffect("server", instance.id)
      )
    },
  })
  forkAppEffect(
    "relay.snapshot.invalidate",
    invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
  )
  publishRealtimeChange({
    directoryChanged: true,
    instance,
    relayId: relay.id,
    type: "server.upsert",
  })
  return instance
}
