import type { RowDataPacket } from "mysql2/promise"
import {
  relayIdSchema,
  relayInstanceNameSchema,
  tunnelSchema,
  type Tunnel as Gateway,
} from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export interface PersistedGateway extends Gateway {
  relayId: string
  relayName: string
}

export interface PendingGatewayCleanup {
  attempts: number
  deployment: PersistedGateway
  lastError: string | null
  requestedBy: string
}

export interface PendingGatewayCleanupBatch {
  cleanups: Array<PendingGatewayCleanup>
  deferredCorruptRows: number
}

export function gatewayCleanupRetryDelaySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(Math.max(1, attempt), 9))
}

interface DeploymentRow extends RowDataPacket {
  cleanup_attempts: number
  cleanup_last_error: string | null
  id: string
  state: unknown
  tunnel_id: string
  relay_id: string
  relay_name?: string
  requested_by: string
}

/**
 * Records the deployments Hearth saw on Relays. Returns how many it hadn't
 * seen before; one belonging to a network being deleted is due for cleanup.
 */
export const observeGatewaysEffect = Effect.fn(
  "tailscaleCleanup.observeDeployments"
)(function* (deployments: ReadonlyArray<PersistedGateway>) {
  if (deployments.length === 0) return 0
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const results = yield* database.transaction(
    "tailscaleCleanup.observeDeployments",
    (tx) =>
      Effect.forEach(deployments, (deployment) =>
        upsertDeployment(tx, deployment, now)
      )
  )
  // MySQL counts an upsert's insert as one affected row and an update as two.
  return results.filter((result) => result.affectedRows === 1).length
})

export const reconcileGatewaysEffect = Effect.fn(
  "tailscaleCleanup.reconcileDeployments"
)(function* (
  networkId: string,
  deployments: ReadonlyArray<PersistedGateway>,
  removedRelayIds: ReadonlyArray<string>
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tailscaleCleanup.reconcileDeployments", (tx) =>
    Effect.gen(function* () {
      if (removedRelayIds.length > 0) {
        const relays = removedRelayIds.map(() => "?").join(", ")
        yield* tx.execute(
          `DELETE FROM ${databaseTable("tunnel_gateway")}
              WHERE tunnel_id = ? AND relay_id IN (${relays})`,
          [networkId, ...removedRelayIds]
        )
      }
      yield* Effect.forEach(
        deployments,
        (deployment) => upsertDeployment(tx, deployment, now),
        { discard: true }
      )
    })
  )
})

export const requestTunnelCleanupEffect = Effect.fn("tailscaleCleanup.request")(
  function* (
    networkId: string,
    requestedBy: string,
    deployments: ReadonlyArray<PersistedGateway>
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction("tailscaleCleanup.request", (tx) =>
      Effect.gen(function* () {
        yield* Effect.forEach(
          deployments,
          (deployment) => upsertDeployment(tx, deployment, now),
          { discard: true }
        )
        yield* tx.execute(
          `UPDATE ${databaseTable("tunnel")}
            SET deletion_requested_at = COALESCE(deletion_requested_at, ?),
                deletion_requested_by = COALESCE(deletion_requested_by, ?),
                cleanup_attempts = 0,
                cleanup_next_attempt_at = ?,
                cleanup_last_error = NULL,
                updated_at = ?
          WHERE id = ?`,
          [now, requestedBy, now, now, networkId]
        )
      })
    )
  }
)

interface NextAttemptRow extends RowDataPacket {
  next_attempt_at: number | string | null
}

/**
 * When a network being deleted next has cleanup due: its earliest Relay
 * removal, or, with no Relays left, its finalization. Null once it's gone.
 */
export const nextTunnelCleanupAttemptEffect = Effect.fn(
  "tailscaleCleanup.nextAttempt"
)(function* (networkId: string) {
  const database = yield* Database
  // A network's own retry applies only once its Relays are cleaned up, as
  // it's finalized then.
  const [row] = yield* database.queryRows<NextAttemptRow>(
    "tailscaleCleanup.nextAttempt",
    `SELECT COALESCE(
              (SELECT MIN(gateway.cleanup_next_attempt_at)
                 FROM ${databaseTable("tunnel_gateway")} gateway
                WHERE gateway.tunnel_id = network.id),
              network.cleanup_next_attempt_at,
              0
            ) AS next_attempt_at
       FROM ${databaseTable("tunnel")} network
      WHERE network.id = ? AND network.deletion_requested_at IS NOT NULL`,
    [networkId]
  )
  return row?.next_attempt_at == null ? null : Number(row.next_attempt_at)
})

/** Networks being deleted, as after an upgrade from the cleanup worker. */
export const tunnelsBeingDeletedEffect = Effect.fn(
  "tailscaleCleanup.networksBeingDeleted"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<RowDataPacket & { id: string }>(
    "tailscaleCleanup.networksBeingDeleted",
    `SELECT id FROM ${databaseTable("tunnel")}
      WHERE deletion_requested_at IS NOT NULL
      ORDER BY deletion_requested_at`
  )
  return rows.map((row) => row.id)
})

/** A network's Relay removals that are due. */
export const loadPendingGatewayCleanupsEffect = Effect.fn(
  "tailscaleCleanup.loadPending"
)(function* (networkId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<DeploymentRow>(
    "tailscaleCleanup.loadPending",
    `SELECT deployment.id, deployment.tunnel_id, deployment.relay_id,
            deployment.state, deployment.cleanup_attempts,
            deployment.cleanup_last_error,
            network.deletion_requested_by AS requested_by
       FROM ${databaseTable("tunnel_gateway")} deployment
       JOIN ${databaseTable("tunnel")} network
         ON network.id = deployment.tunnel_id
      WHERE network.id = ?
        AND network.deletion_requested_at IS NOT NULL
        AND deployment.cleanup_next_attempt_at <= ?
      ORDER BY deployment.cleanup_next_attempt_at, deployment.updated_at`,
    [networkId, now]
  )
  const cleanups = yield* Effect.forEach(rows, (row) =>
    Effect.try({
      try: () => ({
        attempts: row.cleanup_attempts,
        deployment: parseDeployment(row.state, row.id, row.relay_id),
        lastError: row.cleanup_last_error,
        requestedBy: row.requested_by,
      }),
      catch: (cause) => cause,
    }).pipe(
      Effect.map((cleanup) => cleanup satisfies PendingGatewayCleanup),
      Effect.catch((cause) => {
        const attempts = row.cleanup_attempts + 1
        return deferGatewayCleanupEffect(
          row.tunnel_id,
          row.relay_id,
          attempts,
          gatewayCleanupRetryDelaySeconds(attempts),
          `Stored Tailscale cleanup data is invalid: ${errorMessage(cause)}`.slice(
            0,
            512
          )
        ).pipe(Effect.as(null))
      })
    )
  )
  return {
    cleanups: cleanups.filter(
      (cleanup): cleanup is PendingGatewayCleanup => cleanup !== null
    ),
    deferredCorruptRows: cleanups.filter((cleanup) => cleanup === null).length,
  } satisfies PendingGatewayCleanupBatch
})

export const completeGatewayCleanupEffect = Effect.fn(
  "tailscaleCleanup.complete"
)(function* (networkId: string, relayId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tailscaleCleanup.complete", (tx) =>
    Effect.gen(function* () {
      yield* tx.execute(
        `DELETE FROM ${databaseTable("tunnel_gateway")}
          WHERE tunnel_id = ? AND relay_id = ?`,
        [networkId, relayId]
      )
      yield* tx.execute(
        `UPDATE ${databaseTable("tunnel")} network
            SET network.cleanup_attempts = 0,
                network.cleanup_next_attempt_at = ?,
                network.cleanup_last_error = NULL,
                network.updated_at = ?
          WHERE network.id = ?
            AND network.deletion_requested_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM ${databaseTable("tunnel_gateway")} deployment
               WHERE deployment.tunnel_id = network.id
            )`,
        [now, now, networkId]
      )
    })
  )
})

export const deferGatewayCleanupEffect = Effect.fn("tailscaleCleanup.defer")(
  function* (
    networkId: string,
    relayId: string,
    attempts: number,
    delaySeconds: number,
    error: string
  ) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const nextAttemptAt = now + delaySeconds * 1000
    yield* database.transaction("tailscaleCleanup.defer", (tx) =>
      Effect.gen(function* () {
        yield* tx.execute(
          `UPDATE ${databaseTable("tunnel_gateway")}
            SET cleanup_attempts = ?,
                cleanup_next_attempt_at = ?,
                cleanup_last_error = ?,
                updated_at = ?
          WHERE tunnel_id = ? AND relay_id = ?`,
          [attempts, nextAttemptAt, error, now, networkId, relayId]
        )
        yield* tx.execute(
          `UPDATE ${databaseTable("tunnel")}
            SET cleanup_attempts = cleanup_attempts + 1,
                cleanup_next_attempt_at = ?,
                cleanup_last_error = ?,
                updated_at = ?
          WHERE id = ?`,
          [nextAttemptAt, error, now, networkId]
        )
      })
    )
  }
)

export const recordTunnelFinalizationFailureEffect = Effect.fn(
  "tailscaleCleanup.finalizationFailure"
)(function* (networkId: string, delaySeconds: number, error: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "tailscaleCleanup.finalizationFailure",
    `UPDATE ${databaseTable("tunnel")}
        SET cleanup_attempts = cleanup_attempts + 1,
            cleanup_next_attempt_at = ?,
            cleanup_last_error = ?,
            updated_at = ?
      WHERE id = ?`,
    [now + delaySeconds * 1000, error, now, networkId]
  )
})

function upsertDeployment(
  tx: DatabaseTransaction,
  deployment: PersistedGateway,
  now: number
) {
  // A gateway Hearth sees for the first time is its tunnel's. One of a
  // tunnel Hearth doesn't know is left out. A tunnel has one gateway on a
  // Relay, so the one its Relay reports there takes the place of any other
  // Hearth kept, such as one a failed connect left.
  return tx.execute(
    `INSERT INTO ${databaseTable("tunnel_gateway")}
         (id, tunnel_id, relay_id, owner_id, state, cleanup_next_attempt_at,
          observed_at, updated_at)
       SELECT ?, tunnel.id, ?, tunnel.owner_id, ?, ?, ?, ?
         FROM ${databaseTable("tunnel")} tunnel
        WHERE tunnel.id = ?
       ON DUPLICATE KEY UPDATE
         id = VALUES(id),
         state = VALUES(state),
         observed_at = VALUES(observed_at),
         updated_at = VALUES(updated_at)`,
    [
      deployment.id,
      deployment.relayId,
      JSON.stringify(deployment),
      now,
      now,
      now,
      deployment.tailnetId,
    ]
  )
}

function parseDeployment(
  value: unknown,
  gatewayId: string,
  relayId: string
): PersistedGateway {
  const decoded = typeof value === "string" ? JSON.parse(value) : value
  if (typeof decoded !== "object" || decoded === null) {
    throw new Error("Stored Tailscale cleanup is not an object")
  }
  const {
    relayId: candidateRelayId,
    relayName,
    ...stackValue
  } = decoded as Record<string, unknown>
  const stack = tunnelSchema.parse(stackValue)
  if (stack.id !== gatewayId) {
    throw new Error("Stored gateway belongs to another tunnel")
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
