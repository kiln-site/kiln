import { Effect } from "effect"

import {
  completeTailscaleCleanupEffect,
  deferTailscaleCleanupEffect,
  loadPendingTailscaleCleanupsEffect,
  recordTailscaleCleanupFinalizationFailureEffect,
  tailscaleCleanupRetryDelaySeconds,
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

const TAILSCALE_CLEANUP_POLL_INTERVAL_MS = 2_000
const workerState = globalThis as typeof globalThis & {
  __kilnTailscaleCleanupWorkerStarted?: boolean
}

export function scheduleTailscaleCleanupProcessing(): void {
  if (workerState.__kilnTailscaleCleanupWorkerStarted) return
  workerState.__kilnTailscaleCleanupWorkerStarted = true
  Effect.runFork(
    promiseEffect(processTailscaleCleanupJobs).pipe(
      Effect.catch((cause) =>
        Effect.sync(() =>
          console.warn("[Kiln] Tailscale cleanup pass failed:", cause)
        )
      ),
      Effect.andThen(Effect.sleep(TAILSCALE_CLEANUP_POLL_INTERVAL_MS)),
      Effect.forever
    )
  )
}

async function processTailscaleCleanupJobs(): Promise<void> {
  const [pending, definitions, relays] = await Promise.all([
    runAppEffect(
      "tailscale.cleanup.pending",
      loadPendingTailscaleCleanupsEffect()
    ),
    loadDefinitions(),
    listPersistedRelays(),
  ])
  const definitionById = new Map(
    definitions.map((definition) => [definition.id, definition])
  )
  const relayById = new Map(relays.map((relay) => [relay.id, relay]))
  const credentials = new Map<string, Promise<TailscaleOAuthCredential>>()
  let changed = pending.length > 0

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

  const afterCleanup = await loadDefinitions()
  const readyToFinalize = afterCleanup.filter((definition) => {
    const cleanup = definition.cleanup
    if (!cleanup || cleanup.pendingRelays > 0) return false
    return (
      !cleanup.nextAttemptAt ||
      new Date(cleanup.nextAttemptAt).valueOf() <= Date.now()
    )
  })
  changed ||= readyToFinalize.length > 0
  await Promise.all(
    readyToFinalize.map((definition) =>
      Effect.runPromise(
        promiseEffect(() => finalizeNetwork(definition)).pipe(
          Effect.catch((cause) =>
            promiseEffect(() => deferNetworkFinalization(definition, cause))
          )
        )
      )
    )
  )
  if (changed) publishChange()
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
