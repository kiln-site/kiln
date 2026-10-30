import { Duration, Effect, Schema } from "effect"
import { Activity, DurableClock } from "effect/workflow"

import {
  completeTailscaleCleanupEffect,
  deferTailscaleCleanupEffect,
  loadPendingTailscaleCleanupsEffect,
  nextTailscaleCleanupAttemptEffect,
  recordTailscaleCleanupFinalizationFailureEffect,
  tailscaleCleanupRetryDelaySeconds,
  tailscaleNetworksBeingDeletedEffect,
  type PendingTailscaleCleanup,
} from "@/effect/tailscale-cleanup"
import {
  removeTailscaleControlPlaneDeviceEffect,
  syncTailscaleControlPlaneEffect,
} from "@/effect/tailscale-api"
import {
  loadTailscaleNetworkCredentialEffect,
  loadTailscaleNetworkDefinitionsEffect,
  removeTailscaleNetworkDefinitionEffect,
  type TailscaleNetworkDefinition,
  type TailscaleOAuthCredential,
} from "@/effect/tailscale-networks"
import { runAppEffect } from "@/effect/runtime"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import { relayRpc } from "@/lib/relay-connection"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { listPersistedRelays, type PersistedRelay } from "@/lib/relay-registry"
import { durableOperation, startDurableOperation } from "@/operations/durable"

// Deleting a Tailscale network, as one operation on it: each round removes
// the network from the Relays it's due on, two-phase around the tailnet
// device, then, with no Relays left, the network itself. A failure is kept
// on its row with when to try again, and the operation pauses until the
// earliest of those. A network can be deleted only once, so its ID names
// the operation.
export const deleteTailscaleNetwork = durableOperation({
  input: Schema.Struct({ networkId: Schema.String }),
  kind: "tailscale.network.delete",
  run: ({ networkId }) =>
    Effect.gen(function* () {
      for (let round = 1; ; round++) {
        const retryInMs = yield* Activity.make({
          name: `clean/${round}`,
          success: Schema.NullOr(Schema.Number),
          execute: Effect.tryPromise(() => cleanNetwork(networkId)).pipe(
            // Reading what's due failed, not a removal: look again soon.
            Effect.catch(() => Effect.succeed(UNREADABLE_RETRY_MS))
          ),
        })
        if (retryInMs === null) return
        yield* DurableClock.sleep({
          duration: Duration.millis(retryInMs),
          name: `retry/${round}`,
        })
      }
    }),
  version: 1,
})

const UNREADABLE_RETRY_MS = 30_000

/** Starts deleting a network whose deletion was just requested. */
export const startTailscaleNetworkDeletion = (
  networkId: string,
  actorId: string | null
) =>
  startDurableOperation(
    deleteTailscaleNetwork,
    { networkId },
    { actorId, idempotencyKey: networkId }
  )

/**
 * Starts deleting every network whose deletion was requested, as after an
 * upgrade from the cleanup worker. One already being deleted is the same
 * operation.
 */
export const resumeTailscaleNetworkDeletion = Effect.fn(
  "TailscaleCleanup.resume"
)(function* () {
  const networks = yield* tailscaleNetworksBeingDeletedEffect()
  yield* Effect.forEach(
    networks,
    (networkId) => startTailscaleNetworkDeletion(networkId, null),
    { discard: true }
  )
})

// One round for one network. Returns how long until its next attempt is
// due, or null once it's gone.
async function cleanNetwork(networkId: string): Promise<number | null> {
  const [pendingBatch, definitions, relays] = await Promise.all([
    runAppEffect(
      "tailscale.cleanup.pending",
      loadPendingTailscaleCleanupsEffect(networkId)
    ),
    loadDefinitions(),
    listPersistedRelays(),
  ])
  const definitionById = new Map(
    definitions.map((definition) => [definition.id, definition])
  )
  const relayById = new Map(relays.map((relay) => [relay.id, relay]))
  const credentials = new Map<string, Promise<TailscaleOAuthCredential>>()
  const pending = pendingBatch.cleanups
  let changed = pending.length > 0 || pendingBatch.deferredCorruptRows > 0

  await Promise.all(
    pending.map((cleanup) =>
      Effect.runPromise(
        promiseEffect(() =>
          processDeploymentCleanup(
            cleanup,
            definitionById,
            relayById,
            credentials
          )
        ).pipe(
          Effect.catch((cause) =>
            promiseEffect(() => deferDeploymentCleanup(cleanup, cause))
          )
        )
      )
    )
  )

  const definition = (await loadDefinitions()).find(
    (candidate) => candidate.id === networkId
  )
  const cleanup = definition?.cleanup
  if (
    definition &&
    cleanup &&
    cleanup.pendingRelays === 0 &&
    (!cleanup.nextAttemptAt ||
      new Date(cleanup.nextAttemptAt).valueOf() <= Date.now())
  ) {
    changed = true
    await Effect.runPromise(
      promiseEffect(() => finalizeNetwork(definition)).pipe(
        Effect.catch((cause) =>
          promiseEffect(() => deferNetworkFinalization(definition, cause))
        )
      )
    )
  }
  if (changed) publishChange()
  const next = await runAppEffect(
    "tailscale.cleanup.next",
    nextTailscaleCleanupAttemptEffect(networkId)
  )
  return next === null ? null : Math.max(1_000, next - Date.now())
}

async function processDeploymentCleanup(
  cleanup: PendingTailscaleCleanup,
  definitionById: ReadonlyMap<string, TailscaleNetworkDefinition>,
  relayById: ReadonlyMap<string, PersistedRelay>,
  credentials: Map<string, Promise<TailscaleOAuthCredential>>
): Promise<void> {
  const { deployment } = cleanup
  const relay = relayById.get(deployment.relayId)
  if (!relay?.enabled) throw new Error(`${deployment.relayName} is offline`)
  const definition = definitionById.get(deployment.id)
  if (!definition?.cleanup) {
    await completeDeployment(deployment.id, deployment.relayId)
    return
  }
  let credential: TailscaleOAuthCredential | null = null
  if (definition.integration) {
    let credentialPromise = credentials.get(definition.id)
    if (!credentialPromise) {
      credentialPromise = loadCredential(definition.id)
      credentials.set(definition.id, credentialPromise)
    }
    credential = await credentialPromise
  }
  await removeDeployment(relay, deployment.id, "prepare", cleanup.requestedBy)
  if (credential) {
    await runAppEffect(
      "tailscale.controlPlane.removeDevice",
      removeTailscaleControlPlaneDeviceEffect(credential, deployment)
    )
  }
  await removeDeployment(
    relay,
    deployment.id,
    "commit",
    cleanup.requestedBy,
    Boolean(credential)
  )
  await completeDeployment(deployment.id, deployment.relayId)
  await runAppEffect(
    "relay.tailscale.snapshot.invalidate",
    invalidateRelayCache(relayCachePolicy.snapshot(deployment.relayId))
  )
}

async function deferDeploymentCleanup(
  cleanup: PendingTailscaleCleanup,
  cause: unknown
): Promise<void> {
  const { deployment } = cleanup
  const attempts = cleanup.attempts + 1
  await runAppEffect(
    "tailscale.cleanup.defer",
    deferTailscaleCleanupEffect(
      deployment.id,
      deployment.relayId,
      attempts,
      tailscaleCleanupRetryDelaySeconds(attempts),
      errorMessage(cause).slice(0, 512)
    )
  )
}

async function deferNetworkFinalization(
  definition: TailscaleNetworkDefinition,
  cause: unknown
): Promise<void> {
  const attempts = (definition.cleanup?.attempts ?? 0) + 1
  await runAppEffect(
    "tailscale.cleanup.finalization.defer",
    recordTailscaleCleanupFinalizationFailureEffect(
      definition.id,
      tailscaleCleanupRetryDelaySeconds(attempts),
      errorMessage(cause).slice(0, 512)
    )
  )
}

async function finalizeNetwork(
  definition: TailscaleNetworkDefinition
): Promise<void> {
  if (definition.integration) {
    const credential = await loadCredential(definition.id)
    await runAppEffect(
      "tailscale.controlPlane.cleanup",
      syncTailscaleControlPlaneEffect(credential, {
        ...definition,
        deployments: [],
      })
    )
  }
  await runAppEffect(
    "tailscale.networks.remove",
    removeTailscaleNetworkDefinitionEffect(definition.id)
  )
}

function loadDefinitions() {
  return runAppEffect(
    "tailscale.networks.load",
    loadTailscaleNetworkDefinitionsEffect()
  )
}

function loadCredential(id: string) {
  return runAppEffect(
    "tailscale.networks.integration.load",
    loadTailscaleNetworkCredentialEffect(id)
  )
}

function completeDeployment(networkId: string, relayId: string) {
  return runAppEffect(
    "tailscale.cleanup.complete",
    completeTailscaleCleanupEffect(networkId, relayId)
  )
}

async function removeDeployment(
  relay: PersistedRelay,
  id: string,
  mode: "commit" | "prepare",
  subject: string,
  controlPlaneDeviceRemoved = false
): Promise<void> {
  await relayRpc(
    relay,
    "relay.tailscale.stack.remove",
    { controlPlaneDeviceRemoved, id, mode },
    120_000,
    subject
  )
}

function publishChange(): void {
  publishRealtimeChange({
    audience: { kind: "platform-admins" },
    topics: ["tailscale"],
    type: "hearth.invalidate",
  })
}

function promiseEffect<TResult>(
  run: () => PromiseLike<TResult>
): Effect.Effect<TResult, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Tailscale cleanup failed"
}
