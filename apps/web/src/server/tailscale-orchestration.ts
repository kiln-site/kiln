import { Effect } from "effect"

import type {
  RelayTailscaleStackApply,
  RelayTailscaleStackDns,
} from "@workspace/contracts"

import { TailscaleOrchestrationError } from "@/effect/errors"

interface TailscaleBindingState {
  address: string
  enabled: boolean
  hostname: string
  instanceId: string
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
    instanceId: string
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
  syncDns: (
    deployment: TDeployment,
    records: RelayTailscaleStackDns["records"]
  ) => Promise<TDeployment>
}

export const synchronizeInstanceDeletionDnsEffect = Effect.fn(
  "tailscale.instanceDeletion.synchronizeDns"
)(function* <TDeployment extends TailscaleDeploymentState>({
  current,
  instanceId,
  mode,
  operations,
  relayId,
  signal,
  stackIds,
}: {
  current: ReadonlyArray<TDeployment>
  instanceId: string
  mode: "prepare" | "rollback"
  operations: Pick<TailscaleDeploymentOperations<TDeployment>, "syncDns">
  relayId: string
  signal?: AbortSignal
  stackIds: ReadonlyArray<string>
}) {
  yield* ensurePrepareActive(mode, signal)
  const requestedStackIds = new Set(stackIds)
  const deploymentsByStack = new Map<string, Array<TDeployment>>()
  for (const deployment of current) {
    if (!requestedStackIds.has(deployment.id)) continue
    const deployments = deploymentsByStack.get(deployment.id) ?? []
    deployments.push(deployment)
    deploymentsByStack.set(deployment.id, deployments)
  }

  const plans: Array<{
    previousRecords: RelayTailscaleStackDns["records"]
    records: RelayTailscaleStackDns["records"]
    targets: Array<TDeployment>
  }> = []
  for (const stackId of requestedStackIds) {
    yield* ensurePrepareActive(mode, signal)
    const deployments = deploymentsByStack.get(stackId)
    if (!deployments?.length) {
      return yield* orchestrationFailure(
        "validation",
        `Tailscale network ${stackId.slice(0, 8)} is unavailable`
      )
    }
    if (
      mode === "prepare" &&
      !deployments.some(
        (deployment) =>
          deployment.relayId === relayId &&
          deployment.bindings.some(
            (binding) => binding.instanceId === instanceId
          )
      )
    ) {
      return yield* orchestrationFailure(
        "validation",
        `Tailscale network ${deploymentLabel(deployments)} no longer contains this server`
      )
    }

    const previousRecordsWithSource = deploymentRecords(deployments)
    const nextRecords =
      mode === "prepare"
        ? previousRecordsWithSource.filter(
            ({ instanceId: recordInstanceId, relayId: recordRelayId }) =>
              recordInstanceId !== instanceId || recordRelayId !== relayId
          )
        : previousRecordsWithSource
    plans.push({
      previousRecords: previousRecordsWithSource.map(
        ({ address, hostname }) => ({ address, hostname })
      ),
      records: nextRecords.map(({ address, hostname }) => ({
        address,
        hostname,
      })),
      targets:
        mode === "prepare"
          ? deployments.filter((deployment) => deployment.relayId !== relayId)
          : deployments,
    })
  }

  if (mode === "rollback") {
    const tasks = plans.flatMap((plan) =>
      plan.targets.map((deployment) => ({ deployment, records: plan.records }))
    )
    const [failures] = yield* Effect.partition(
      tasks,
      ({ deployment, records }) =>
        syncDnsEffect(operations, deployment, records, "rollback").pipe(
          Effect.mapError((error) =>
            rollbackFailure(deployment.relayName, error)
          )
        ),
      { concurrency: "unbounded" }
    )
    if (failures.length > 0) {
      return yield* orchestrationFailure(
        "rollback",
        `Could not restore Tailscale DNS after server deletion failed: ${failures.join("; ")}`
      )
    }
    return
  }

  const synchronized: Array<{
    deployment: TDeployment
    previousRecords: RelayTailscaleStackDns["records"]
  }> = []

  yield* Effect.forEach(
    plans,
    (plan) =>
      Effect.forEach(
        plan.targets,
        (deployment) =>
          Effect.gen(function* () {
            yield* ensurePrepareActive(mode, signal)
            const updated = yield* syncDnsEffect(
              operations,
              deployment,
              plan.records,
              "prepare"
            )
            synchronized.push({
              deployment: updated,
              previousRecords: plan.previousRecords,
            })
            yield* ensurePrepareActive(mode, signal)
          }),
        { discard: true }
      ),
    { discard: true }
  ).pipe(
    Effect.catch((cause) => {
      const rollbackTargets = [...synchronized].reverse()
      return Effect.partition(
        rollbackTargets,
        ({ deployment, previousRecords }) =>
          syncDnsEffect(
            operations,
            deployment,
            previousRecords,
            "rollback"
          ).pipe(
            Effect.mapError((error) =>
              rollbackFailure(deployment.relayName, error)
            )
          ),
        { concurrency: "unbounded" }
      ).pipe(
        Effect.flatMap(([rollbackFailures]) =>
          orchestrationFailure(
            "prepare",
            `Could not prepare Tailscale DNS for server deletion: ${errorMessage(
              cause
            )}${
              rollbackFailures.length
                ? `. DNS rollback also failed: ${rollbackFailures.join("; ")}`
                : ""
            }`,
            cause
          )
        )
      )
    })
  )
})

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

    const records = applied.flatMap((deployment) =>
      deployment.bindings.flatMap(({ address, enabled, hostname }) =>
        enabled ? [{ address, hostname }] : []
      )
    )
    const [dnsFailures, synchronizedDeployments] = yield* Effect.partition(
      applied,
      (deployment) => syncDnsEffect(operations, deployment, records, "dns"),
      { concurrency: "unbounded" }
    )
    const firstDnsFailure = dnsFailures[0]
    if (firstDnsFailure !== undefined) {
      return yield* Effect.fail(firstDnsFailure)
    }

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
    if (beforeFinalize) {
      yield* promiseOperation("finalize", () =>
        beforeFinalize(synchronizedDeployments)
      )
    }
    return synchronizedDeployments
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
  const [cleanupFailures] = yield* Effect.partition(
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
  const [removalFailures] = yield* Effect.partition(
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
  const [deploymentFailures] = yield* Effect.partition(
    rollbackDeployments,
    (deployment) => {
      const previous = previousByRelay.get(deployment.relayId)
      const rollback = previous
        ? promiseOperation("rollback", () =>
            operations.apply(deploymentTarget(previous), {
              bindings: previous.bindings.map(
                ({ enabled, hostname, instanceId }) => ({
                  enabled,
                  hostname,
                  instanceId,
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

  const records = current.flatMap((deployment) =>
    deployment.bindings.flatMap(({ address, enabled, hostname }) =>
      enabled ? [{ address, hostname }] : []
    )
  )
  const [dnsFailures] = yield* Effect.partition(
    current,
    (deployment) =>
      syncDnsEffect(operations, deployment, records, "rollback").pipe(
        Effect.mapError((error) => rollbackFailure(deployment.relayName, error))
      ),
    { concurrency: "unbounded" }
  )
  return [...removalFailures, ...deploymentFailures, ...dnsFailures]
})

function syncDnsEffect<TDeployment extends TailscaleDeploymentState>(
  operations: Pick<TailscaleDeploymentOperations<TDeployment>, "syncDns">,
  deployment: TDeployment,
  records: RelayTailscaleStackDns["records"],
  phase: "dns" | "prepare" | "rollback"
) {
  return promiseOperation(phase, () => operations.syncDns(deployment, records))
}

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

function ensurePrepareActive(
  mode: "prepare" | "rollback",
  signal?: AbortSignal
) {
  return mode === "prepare" && signal?.aborted
    ? orchestrationFailure("prepare", "Tailscale DNS preparation was cancelled")
    : Effect.void
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
    bindings: deployment.bindings.map(({ enabled, hostname, instanceId }) => ({
      enabled,
      hostname,
      instanceId,
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

function deploymentLabel(
  deployments: ReadonlyArray<TailscaleDeploymentState>
): string {
  return deployments[0]?.name ?? "network"
}

function deploymentRecords(
  deployments: ReadonlyArray<TailscaleDeploymentState>
): Array<{
  address: string
  hostname: string
  instanceId: string
  relayId: string
}> {
  return deployments.flatMap((deployment) =>
    deployment.bindings.flatMap((binding) =>
      binding.enabled ? [{ ...binding, relayId: deployment.relayId }] : []
    )
  )
}
