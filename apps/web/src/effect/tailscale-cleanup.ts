import type { RowDataPacket } from "mysql2/promise"
import {
  relayIdSchema,
  relayInstanceNameSchema,
  relayTailscaleStackSchema,
  type RelayTailscaleStack,
} from "@workspace/contracts"
import { Effect } from "effect"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export interface PersistedTailscaleDeployment extends RelayTailscaleStack {
  relayId: string
  relayName: string
}

export interface PendingTailscaleCleanup {
  attempts: number
  deployment: PersistedTailscaleDeployment
  lastError: string | null
  requestedBy: string
}

export function tailscaleCleanupRetryDelaySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(Math.max(1, attempt), 9))
}

interface DeploymentRow extends RowDataPacket {
  cleanup_attempts: number
  cleanup_last_error: string | null
  deployment: unknown
  network_id: string
  relay_id: string
  relay_name?: string
  requested_by: string
}

export const observeTailscaleDeploymentsEffect = Effect.fn(
  "tailscaleCleanup.observeDeployments"
)(function* (deployments: ReadonlyArray<PersistedTailscaleDeployment>) {
  if (deployments.length === 0) return
  const database = yield* Database
  yield* database.transaction("tailscaleCleanup.observeDeployments", (tx) =>
    Effect.forEach(
      deployments,
      (deployment) => upsertDeployment(tx, deployment),
      {
        discard: true,
      }
    )
  )
})

export const reconcileTailscaleDeploymentsEffect = Effect.fn(
  "tailscaleCleanup.reconcileDeployments"
)(function* (
  networkId: string,
  deployments: ReadonlyArray<PersistedTailscaleDeployment>,
  removedRelayIds: ReadonlyArray<string>
) {
  const database = yield* Database
  yield* database.transaction("tailscaleCleanup.reconcileDeployments", (tx) =>
    Effect.gen(function* () {
      if (removedRelayIds.length > 0) {
        yield* tx.execute(
          `DELETE FROM ${databaseTable("tailscale_network_deployment")}
              WHERE network_id = ?
                AND relay_id IN (${removedRelayIds.map(() => "?").join(", ")})`,
          [networkId, ...removedRelayIds]
        )
      }
      yield* Effect.forEach(
        deployments,
        (deployment) => upsertDeployment(tx, deployment),
        { discard: true }
      )
    })
  )
})

export const requestTailscaleNetworkCleanupEffect = Effect.fn(
  "tailscaleCleanup.request"
)(function* (
  networkId: string,
  requestedBy: string,
  deployments: ReadonlyArray<PersistedTailscaleDeployment>
) {
  const database = yield* Database
  yield* database.transaction("tailscaleCleanup.request", (tx) =>
    Effect.gen(function* () {
      yield* Effect.forEach(
        deployments,
        (deployment) => upsertDeployment(tx, deployment),
        { discard: true }
      )
      yield* tx.execute(
        `UPDATE ${databaseTable("tailscale_network")}
            SET deletion_requested_at = COALESCE(deletion_requested_at, CURRENT_TIMESTAMP(3)),
                deletion_requested_by = COALESCE(deletion_requested_by, ?),
                cleanup_attempts = 0,
                cleanup_next_attempt_at = CURRENT_TIMESTAMP(3),
                cleanup_last_error = NULL
          WHERE id = ?`,
        [requestedBy, networkId]
      )
    })
  )
})

export const loadPendingTailscaleCleanupsEffect = Effect.fn(
  "tailscaleCleanup.loadPending"
)(function* (limit = 10) {
  const database = yield* Database
  const rows = yield* database.queryRows<DeploymentRow>(
    "tailscaleCleanup.loadPending",
    `SELECT deployment.network_id, deployment.relay_id,
            deployment.deployment, deployment.cleanup_attempts,
            deployment.cleanup_last_error,
            network.deletion_requested_by AS requested_by
       FROM ${databaseTable("tailscale_network_deployment")} deployment
       JOIN ${databaseTable("tailscale_network")} network
         ON network.id = deployment.network_id
      WHERE network.deletion_requested_at IS NOT NULL
        AND deployment.cleanup_next_attempt_at <= CURRENT_TIMESTAMP(3)
      ORDER BY deployment.cleanup_next_attempt_at, deployment.updated_at
      LIMIT ?`,
    [limit]
  )
  const cleanups = yield* Effect.forEach(rows, (row) =>
    Effect.try({
      try: () => ({
        attempts: row.cleanup_attempts,
        deployment: parseDeployment(
          row.deployment,
          row.network_id,
          row.relay_id
        ),
        lastError: row.cleanup_last_error,
        requestedBy: row.requested_by,
      }),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((cleanup) => cleanup satisfies PendingTailscaleCleanup),
      Effect.catch((cause) => {
        const attempts = row.cleanup_attempts + 1
        return deferTailscaleCleanupEffect(
          row.network_id,
          row.relay_id,
          attempts,
          tailscaleCleanupRetryDelaySeconds(attempts),
          `Stored Tailscale cleanup data is invalid: ${errorMessage(cause)}`.slice(
            0,
            512
          )
        ).pipe(Effect.as(null))
      })
    )
  )
  return cleanups.filter(
    (cleanup): cleanup is PendingTailscaleCleanup => cleanup !== null
  )
})

export const completeTailscaleCleanupEffect = Effect.fn(
  "tailscaleCleanup.complete"
)(function* (networkId: string, relayId: string) {
  const database = yield* Database
  yield* database.execute(
    "tailscaleCleanup.complete",
    `DELETE FROM ${databaseTable("tailscale_network_deployment")}
      WHERE network_id = ? AND relay_id = ?`,
    [networkId, relayId]
  )
})

export const deferTailscaleCleanupEffect = Effect.fn("tailscaleCleanup.defer")(
  function* (
    networkId: string,
    relayId: string,
    attempts: number,
    delaySeconds: number,
    error: string
  ) {
    const database = yield* Database
    yield* database.transaction("tailscaleCleanup.defer", (tx) =>
      Effect.gen(function* () {
        yield* tx.execute(
          `UPDATE ${databaseTable("tailscale_network_deployment")}
            SET cleanup_attempts = ?,
                cleanup_next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)),
                cleanup_last_error = ?
          WHERE network_id = ? AND relay_id = ?`,
          [attempts, delaySeconds, error, networkId, relayId]
        )
        yield* tx.execute(
          `UPDATE ${databaseTable("tailscale_network")}
            SET cleanup_attempts = cleanup_attempts + 1,
                cleanup_next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)),
                cleanup_last_error = ?
          WHERE id = ?`,
          [delaySeconds, error, networkId]
        )
      })
    )
  }
)

export const recordTailscaleCleanupFinalizationFailureEffect = Effect.fn(
  "tailscaleCleanup.finalizationFailure"
)(function* (networkId: string, delaySeconds: number, error: string) {
  const database = yield* Database
  yield* database.execute(
    "tailscaleCleanup.finalizationFailure",
    `UPDATE ${databaseTable("tailscale_network")}
        SET cleanup_attempts = cleanup_attempts + 1,
            cleanup_next_attempt_at = TIMESTAMPADD(SECOND, ?, CURRENT_TIMESTAMP(3)),
            cleanup_last_error = ?
      WHERE id = ?`,
    [delaySeconds, error, networkId]
  )
})

function upsertDeployment(
  tx: DatabaseTransaction,
  deployment: PersistedTailscaleDeployment
) {
  return tx.execute(
    `INSERT INTO ${databaseTable("tailscale_network_deployment")}
       (network_id, relay_id, deployment)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE
       deployment = VALUES(deployment),
       observed_at = CURRENT_TIMESTAMP(3)`,
    [deployment.id, deployment.relayId, JSON.stringify(deployment)]
  )
}

function parseDeployment(
  value: unknown,
  networkId: string,
  relayId: string
): PersistedTailscaleDeployment {
  const decoded = typeof value === "string" ? JSON.parse(value) : value
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Stored Tailscale cleanup is not an object")
  }
  const {
    relayId: candidateRelayId,
    relayName,
    ...stackValue
  } = decoded as Record<string, unknown>
  const stack = relayTailscaleStackSchema.parse(stackValue)
  if (stack.id !== networkId) {
    throw new Error("Stored Tailscale cleanup belongs to another network")
  }
  const storedRelayId = relayIdSchema.parse(candidateRelayId ?? relayId)
  if (storedRelayId !== relayId) {
    throw new Error("Stored Tailscale cleanup belongs to another Relay")
  }
  return {
    ...stack,
    relayId: storedRelayId,
    relayName: relayInstanceNameSchema.parse(relayName),
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "unknown error"
}
