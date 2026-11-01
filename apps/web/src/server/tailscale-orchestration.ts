import { Effect } from "effect"

import type { RelayTailscaleStackApply } from "@workspace/contracts"

import { TailscaleOrchestrationError } from "@/effect/errors"

interface TailscaleBindingState {
  address: string
  enabled: boolean
  hostname: string
  memberId: string
}

export interface TailscaleDeploymentState {
  bindings: Array<TailscaleBindingState>
  domain: string
  hostname: string
  id: string
  name: string
  relayId: string
  relayName: string
  subnet: string
}

export interface DesiredTailscaleDeployment {
  bindings: Array<{
    enabled: boolean
    hostname: string
    memberId: string
  }>
  hostname: string
  relayId: string
  relayName: string
}

export type TailscaleRemovalMode = "commit" | "prepare" | "rollback"

export interface TailscaleDeploymentOperations<
  TDeployment extends TailscaleDeploymentState,
> {
  apply: (
    target: DesiredTailscaleDeployment,
    input: RelayTailscaleStackApply
  ) => Promise<TDeployment>
  remove: (deployment: TDeployment, mode: TailscaleRemovalMode) => Promise<void>
  /**
   * Rewrites the network's DNS on every node of it from what the Relays
   * hold now (`writeTailscaleNetworkDns`), never from what a step returned.
   */
  rewriteDns: () => Promise<void>
}

export const applyTailscaleDeploymentPlanEffect = Effect.fn(
  "tailscale.deployment.applyPlan"
)(function* <TDeployment extends TailscaleDeploymentState>({
  authKey,
  authKeyForTarget,
  current,
  desired,
  domain,
  id,
  name,
  operations,
  beforeFinalize,
  reservedSubnets = new Set(),
}: {
  authKey?: string
  authKeyForTarget?: (
    target: DesiredTailscaleDeployment
  ) => Promise<string | undefined>
  current: ReadonlyArray<TDeployment>
  desired: ReadonlyArray<DesiredTailscaleDeployment>
  domain: string
  id: string
  name: string
  operations: TailscaleDeploymentOperations<TDeployment>
  beforeFinalize?: (deployments: ReadonlyArray<TDeployment>) => Promise<void>
  reservedSubnets?: ReadonlySet<string>
}) {
  const previousByRelay = new Map(
    current.map((deployment) => [deployment.relayId, deployment])
  )
  const desiredRelayIds = new Set(desired.map(({ relayId }) => relayId))
  const removed = current.filter(({ relayId }) => !desiredRelayIds.has(relayId))
  const applied: Array<TDeployment> = []
  const preparedRemovals: Array<TDeployment> = []
  const newTargetCount = desired.filter(
    ({ relayId }) => !previousByRelay.has(relayId)
  ).length
  if (newTargetCount > 1 && !authKeyForTarget) {
    return yield* orchestrationFailure(
      "validation",
      "A manual auth key can add one new Relay at a time. Generate a separate key for each Relay."
    )
  }

  const synchronized = yield* Effect.gen(function* () {
    // A later node may reject a one-time key or fail during installation.
    // Applying one node at a time lets us compensate every completed peer.
    yield* Effect.forEach(
      desired,
      (target) =>
        Effect.gen(function* () {
          const previous = previousByRelay.get(target.relayId)
          const targetAuthKey = previous
            ? undefined
            : authKeyForTarget
              ? yield* promiseOperation("apply", () => authKeyForTarget(target))
              : authKey
          const deployment = yield* promiseOperation("apply", () =>
            operations.apply(target, {
              ...(targetAuthKey ? { authKey: targetAuthKey } : {}),
              bindings: target.bindings,
              domain,
              hostname: target.hostname,
              id,
              name,
            })
          )
          const peer = applied.find(
            (candidate) => candidate.subnet === deployment.subnet
          )
          applied.push(deployment)
          if (reservedSubnets.has(deployment.subnet) || peer) {
            return yield* orchestrationFailure(
              "validation",
              `${deployment.subnet} is already assigned to another Tailscale node`
            )
          }
        }),
      { discard: true }
    )

    // Preparing a removal keeps its identity on disk, so every prepared node
    // can be restored if a later node or control-plane update fails.
    yield* Effect.forEach(
      removed,
      (deployment) =>
        Effect.gen(function* () {
          preparedRemovals.push(deployment)
          yield* promiseOperation("prepare", () =>
            operations.remove(deployment, "prepare")
          )
        }),
      { discard: true }
    )
    // From what the Relays hold now, members frozen for deletion left out,
    // and nodes being removed serving none.
    yield* promiseOperation("dns", () => operations.rewriteDns())
    if (beforeFinalize) {
      yield* promiseOperation("finalize", () => beforeFinalize(applied))
    }
    return applied
  }).pipe(
    Effect.catch((cause) =>
      rollbackTailscaleDeploymentPlanEffect(
        current,
        applied,
        preparedRemovals,
        operations
      ).pipe(
        Effect.flatMap((rollbackFailures) =>
          orchestrationFailure(
            "apply",
            `Could not update Tailscale network: ${errorMessage(cause)}.${
              rollbackFailures.length
                ? ` Rollback also failed: ${rollbackFailures.join("; ")}`
                : ""
            }`,
            cause
          )
        )
      )
    )
  )

  // Cleanup starts only after the desired state is durable. It is retried and
  // reported separately because rolling back here would disagree with the
  // already-finalized database and Tailscale control plane.
  const [, cleanupFailures] = yield* Effect.partition(
    preparedRemovals,
    (deployment) =>
      promiseOperation("cleanup", () =>
        operations.remove(deployment, "commit")
      ).pipe(
        Effect.retry({ times: 2 }),
        Effect.mapError((error) => rollbackFailure(deployment.relayName, error))
      ),
    { concurrency: "unbounded" }
  )
  if (cleanupFailures.length > 0) {
    return yield* orchestrationFailure(
      "cleanup",
      `Tailscale network was updated, but Relay cleanup failed after 3 attempts: ${cleanupFailures.join("; ")}. Retry the change to finish cleanup.`
    )
  }
  return synchronized
})

const rollbackTailscaleDeploymentPlanEffect = Effect.fn(
  "tailscale.deployment.rollbackPlan"
)(function* <TDeployment extends TailscaleDeploymentState>(
  current: ReadonlyArray<TDeployment>,
  applied: ReadonlyArray<TDeployment>,
  preparedRemovals: ReadonlyArray<TDeployment>,
  operations: TailscaleDeploymentOperations<TDeployment>
) {
  const previousByRelay = new Map(
    current.map((deployment) => [deployment.relayId, deployment])
  )

  const removalRollbacks = [...preparedRemovals].reverse()
  const [, removalFailures] = yield* Effect.partition(
    removalRollbacks,
    (deployment) =>
      promiseOperation("rollback", () =>
        operations.remove(deployment, "rollback")
      ).pipe(
        Effect.mapError((error) => rollbackFailure(deployment.relayName, error))
      ),
    { concurrency: "unbounded" }
  )

  const rollbackDeployments = [...applied].reverse()
  const [, deploymentFailures] = yield* Effect.partition(
    rollbackDeployments,
    (deployment) => {
      const previous = previousByRelay.get(deployment.relayId)
      const rollback = previous
        ? promiseOperation("rollback", () =>
            operations.apply(deploymentTarget(previous), {
              bindings: previous.bindings.map(
                ({ enabled, hostname, memberId }) => ({
                  enabled,
                  hostname,
                  memberId,
                })
              ),
              domain: previous.domain,
              hostname: previous.hostname,
              id: previous.id,
              name: previous.name,
            })
          )
        : Effect.gen(function* () {
            yield* promiseOperation("rollback", () =>
              operations.remove(deployment, "prepare")
            )
            yield* promiseOperation("rollback", () =>
              operations.remove(deployment, "commit")
            )
          })
      return rollback.pipe(
        Effect.mapError((error) => rollbackFailure(deployment.relayName, error))
      )
    },
    { concurrency: "unbounded" }
  )

  // What the Relays hold once put back, not what they held before.
  const dnsFailure = yield* promiseOperation("rollback", () =>
    operations.rewriteDns()
  ).pipe(
    Effect.as([] as Array<string>),
    Effect.catch((error) => Effect.succeed([`DNS: ${errorMessage(error)}`]))
  )
  return [...removalFailures, ...deploymentFailures, ...dnsFailure]
})

function promiseOperation<TResult>(
  phase: TailscaleOrchestrationError["phase"],
  run: () => Promise<TResult>
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      TailscaleOrchestrationError.make({
        phase,
        reason: errorMessage(cause),
        cause,
      }),
  })
}

function orchestrationFailure(
  phase: TailscaleOrchestrationError["phase"],
  reason: string,
  cause?: unknown
) {
  return Effect.fail(
    TailscaleOrchestrationError.make({
      phase,
      reason,
      ...(cause === undefined ? {} : { cause }),
    })
  )
}

function deploymentTarget(
  deployment: TailscaleDeploymentState
): DesiredTailscaleDeployment {
  return {
    bindings: deployment.bindings.map(({ enabled, hostname, memberId }) => ({
      enabled,
      hostname,
      memberId,
    })),
    hostname: deployment.hostname,
    relayId: deployment.relayId,
    relayName: deployment.relayName,
  }
}

function rollbackFailure(relayName: string, cause: unknown): string {
  return `${relayName}: ${errorMessage(cause)}`
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown error"
}
