import { Effect } from "effect"

import type { TunnelApply as GatewayApply } from "@workspace/contracts"

import { TailscaleOrchestrationError } from "@/effect/errors"

interface TailscaleBindingState {
  address: string
  enabled: boolean
  memberId: string
}

export interface GatewayPlanState {
  bindings: Array<TailscaleBindingState>
  domains: Array<string>
  hostname: string
  id: string
  name: string
  relayId: string
  relayName: string
  subnet: string
  tailnetId: string
}

export interface DesiredGateway {
  bindings: Array<{
    enabled: boolean
    memberId: string
  }>
  hostname: string
  /** The tunnel's ID: the one the tunnel has on the Relay, or a new one. */
  id: string
  relayId: string
  relayName: string
}

export type TailscaleRemovalMode = "commit" | "prepare" | "rollback"

export interface GatewayOperations<TDeployment extends GatewayPlanState> {
  apply: (target: DesiredGateway, input: GatewayApply) => Promise<TDeployment>
  remove: (deployment: TDeployment, mode: TailscaleRemovalMode) => Promise<void>
  /**
   * Takes away what a new gateway left that failed before it finished: its
   * Tailscale device, logged in before the Relay gave up and removed the
   * rest.
   */
  discard?: (target: DesiredGateway) => Promise<void>
  /**
   * Rewrites the network's DNS on every node of it from what the Relays
   * hold now (`writeTunnelDns`), never from what a step returned.
   */
  rewriteDns: () => Promise<void>
}

export const applyGatewayPlanEffect = Effect.fn(
  "tailscale.deployment.applyPlan"
)(function* <TDeployment extends GatewayPlanState>({
  authKeyForTarget,
  brick,
  current,
  desired,
  domains,
  id,
  name,
  operations,
  beforeFinalize,
  reservedSubnets = new Set(),
}: {
  /** A key a new gateway logs in with, made with its tunnel's login. */
  authKeyForTarget?: (target: DesiredGateway) => Promise<string | undefined>
  /** The Brick each gateway it adds is made from. */
  brick?: GatewayApply["brick"]
  current: ReadonlyArray<TDeployment>
  desired: ReadonlyArray<DesiredGateway>
  domains: Array<string>
  id: string
  name: string
  operations: GatewayOperations<TDeployment>
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
  if (newTargetCount > 0 && !brick) {
    return yield* orchestrationFailure(
      "validation",
      "Choose the Brick a new gateway runs"
    )
  }
  if (newTargetCount > 0 && !authKeyForTarget) {
    return yield* orchestrationFailure(
      "validation",
      "A new gateway needs its tunnel's Tailscale login"
    )
  }

  // The new gateway being applied, until it is.
  let unfinished: DesiredGateway | null = null
  const synchronized = yield* Effect.gen(function* () {
    // A later node may reject a one-time key or fail during installation.
    // Applying one node at a time lets us compensate every completed peer.
    yield* Effect.forEach(
      desired,
      (target) =>
        Effect.gen(function* () {
          const previous = previousByRelay.get(target.relayId)
          unfinished = previous ? null : target
          const targetAuthKey =
            previous || !authKeyForTarget
              ? undefined
              : yield* promiseOperation("apply", () => authKeyForTarget(target))
          const deployment = yield* promiseOperation("apply", () =>
            operations.apply(target, {
              ...(targetAuthKey ? { authKey: targetAuthKey } : {}),
              // A gateway keeps the Brick it was made from.
              ...(previous ? {} : { brick }),
              bindings: target.bindings,
              domains,
              hostname: target.hostname,
              id: target.id,
              name,
              tailnetId: id,
            })
          )
          unfinished = null
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
      rollbackGatewayPlanEffect(
        current,
        applied,
        preparedRemovals,
        operations,
        unfinished
      ).pipe(
        Effect.flatMap((rollbackFailures) =>
          orchestrationFailure(
            "apply",
            `Could not update the tunnel: ${errorMessage(cause)}.${
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
      `The tunnel was updated, but Relay cleanup failed after 3 attempts: ${cleanupFailures.join("; ")}. Retry the change to finish cleanup.`
    )
  }
  return synchronized
})

const rollbackGatewayPlanEffect = Effect.fn(
  "tailscale.deployment.rollbackPlan"
)(function* <TDeployment extends GatewayPlanState>(
  current: ReadonlyArray<TDeployment>,
  applied: ReadonlyArray<TDeployment>,
  preparedRemovals: ReadonlyArray<TDeployment>,
  operations: GatewayOperations<TDeployment>,
  unfinished: DesiredGateway | null
) {
  const discardFailures: Array<string> = []
  if (unfinished && operations.discard) {
    const target = unfinished
    yield* promiseOperation("rollback", () => operations.discard!(target)).pipe(
      Effect.catch((error) =>
        Effect.sync(() => {
          discardFailures.push(rollbackFailure(target.relayName, error))
        })
      )
    )
  }
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
              bindings: previous.bindings.map(({ enabled, memberId }) => ({
                enabled,
                memberId,
              })),
              domains: previous.domains,
              hostname: previous.hostname,
              id: previous.id,
              name: previous.name,
              tailnetId: previous.tailnetId,
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
  return [
    ...discardFailures,
    ...removalFailures,
    ...deploymentFailures,
    ...dnsFailure,
  ]
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

function deploymentTarget(deployment: GatewayPlanState): DesiredGateway {
  return {
    bindings: deployment.bindings.map(({ enabled, memberId }) => ({
      enabled,
      memberId,
    })),
    hostname: deployment.hostname,
    id: deployment.id,
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
