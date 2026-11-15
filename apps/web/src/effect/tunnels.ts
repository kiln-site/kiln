import type { RowDataPacket } from "mysql2/promise"
import {
  relayIdSchema,
  relayInstanceNameSchema,
  tunnelSchema,
  type Tunnel,
} from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { Database, type DatabaseTransaction } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export interface PersistedTunnel extends Tunnel {
  relayId: string
  relayName: string
}

export interface PendingTunnelCleanup {
  attempts: number
  deployment: PersistedTunnel
  lastError: string | null
  requestedBy: string
}

export interface PendingTunnelCleanupBatch {
  cleanups: Array<PendingTunnelCleanup>
  deferredCorruptRows: number
}

export function tunnelCleanupRetryDelaySeconds(attempt: number): number {
  return Math.min(300, 2 ** Math.min(Math.max(1, attempt), 9))
}

interface DeploymentRow extends RowDataPacket {
  cleanup_attempts: number
  cleanup_last_error: string | null
  id: string
  state: unknown
  tailnet_id: string
  relay_id: string
  relay_name?: string
  requested_by: string
}

/**
 * Records the deployments Hearth saw on Relays. Returns how many it hadn't
 * seen before; one belonging to a network being deleted is due for cleanup.
 */
export const observeTunnelsEffect = Effect.fn(
  "tailscaleCleanup.observeDeployments"
)(function* (deployments: ReadonlyArray<PersistedTunnel>) {
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

export const reconcileTunnelsEffect = Effect.fn(
  "tailscaleCleanup.reconcileDeployments"
)(function* (
  networkId: string,
  deployments: ReadonlyArray<PersistedTunnel>,
  removedRelayIds: ReadonlyArray<string>
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tailscaleCleanup.reconcileDeployments", (tx) =>
    Effect.gen(function* () {
      if (removedRelayIds.length > 0) {
        const relays = removedRelayIds.map(() => "?").join(", ")
        yield* tx.execute(
          `DELETE member FROM ${databaseTable("instance_group_member")} member
             JOIN ${databaseTable("tunnel")} tunnel ON tunnel.id = member.instance_id
            WHERE tunnel.tailnet_id = ? AND tunnel.relay_id IN (${relays})`,
          [networkId, ...removedRelayIds]
        )
        yield* tx.execute(
          `DELETE FROM ${databaseTable("tunnel")}
              WHERE tailnet_id = ? AND relay_id IN (${relays})`,
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

export const requestTailnetCleanupEffect = Effect.fn(
  "tailscaleCleanup.request"
)(function* (
  networkId: string,
  requestedBy: string,
  deployments: ReadonlyArray<PersistedTunnel>
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
        `UPDATE ${databaseTable("tailnet")}
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
})

interface NextAttemptRow extends RowDataPacket {
  next_attempt_at: number | string | null
}

/**
 * When a network being deleted next has cleanup due: its earliest Relay
 * removal, or, with no Relays left, its finalization. Null once it's gone.
 */
export const nextTailnetCleanupAttemptEffect = Effect.fn(
  "tailscaleCleanup.nextAttempt"
)(function* (networkId: string) {
  const database = yield* Database
  // A network's own retry applies only once its Relays are cleaned up, as
  // it's finalized then.
  const [row] = yield* database.queryRows<NextAttemptRow>(
    "tailscaleCleanup.nextAttempt",
    `SELECT COALESCE(
              (SELECT MIN(tunnel.cleanup_next_attempt_at)
                 FROM ${databaseTable("tunnel")} tunnel
                WHERE tunnel.tailnet_id = network.id),
              network.cleanup_next_attempt_at,
              0
            ) AS next_attempt_at
       FROM ${databaseTable("tailnet")} network
      WHERE network.id = ? AND network.deletion_requested_at IS NOT NULL`,
    [networkId]
  )
  return row?.next_attempt_at == null ? null : Number(row.next_attempt_at)
})

/** Networks being deleted, as after an upgrade from the cleanup worker. */
export const tailnetsBeingDeletedEffect = Effect.fn(
  "tailscaleCleanup.networksBeingDeleted"
)(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<RowDataPacket & { id: string }>(
    "tailscaleCleanup.networksBeingDeleted",
    `SELECT id FROM ${databaseTable("tailnet")}
      WHERE deletion_requested_at IS NOT NULL
      ORDER BY deletion_requested_at`
  )
  return rows.map((row) => row.id)
})

/** A network's Relay removals that are due. */
export const loadPendingTunnelCleanupsEffect = Effect.fn(
  "tailscaleCleanup.loadPending"
)(function* (networkId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const rows = yield* database.queryRows<DeploymentRow>(
    "tailscaleCleanup.loadPending",
    `SELECT deployment.id, deployment.tailnet_id, deployment.relay_id,
            deployment.state, deployment.cleanup_attempts,
            deployment.cleanup_last_error,
            network.deletion_requested_by AS requested_by
       FROM ${databaseTable("tunnel")} deployment
       JOIN ${databaseTable("tailnet")} network
         ON network.id = deployment.tailnet_id
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
      Effect.map((cleanup) => cleanup satisfies PendingTunnelCleanup),
      Effect.catch((cause) => {
        const attempts = row.cleanup_attempts + 1
        return deferTunnelCleanupEffect(
          row.tailnet_id,
          row.relay_id,
          attempts,
          tunnelCleanupRetryDelaySeconds(attempts),
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
      (cleanup): cleanup is PendingTunnelCleanup => cleanup !== null
    ),
    deferredCorruptRows: cleanups.filter((cleanup) => cleanup === null).length,
  } satisfies PendingTunnelCleanupBatch
})

export const completeTunnelCleanupEffect = Effect.fn(
  "tailscaleCleanup.complete"
)(function* (networkId: string, relayId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.transaction("tailscaleCleanup.complete", (tx) =>
    Effect.gen(function* () {
      yield* tx.execute(
        `DELETE member FROM ${databaseTable("instance_group_member")} member
           JOIN ${databaseTable("tunnel")} tunnel ON tunnel.id = member.instance_id
          WHERE tunnel.tailnet_id = ? AND tunnel.relay_id = ?`,
        [networkId, relayId]
      )
      yield* tx.execute(
        `DELETE FROM ${databaseTable("tunnel")}
          WHERE tailnet_id = ? AND relay_id = ?`,
        [networkId, relayId]
      )
      yield* tx.execute(
        `UPDATE ${databaseTable("tailnet")} network
            SET network.cleanup_attempts = 0,
                network.cleanup_next_attempt_at = ?,
                network.cleanup_last_error = NULL,
                network.updated_at = ?
          WHERE network.id = ?
            AND network.deletion_requested_at IS NOT NULL
            AND NOT EXISTS (
              SELECT 1
                FROM ${databaseTable("tunnel")} deployment
               WHERE deployment.tailnet_id = network.id
            )`,
        [now, now, networkId]
      )
    })
  )
})

export const deferTunnelCleanupEffect = Effect.fn("tailscaleCleanup.defer")(
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
          `UPDATE ${databaseTable("tunnel")}
            SET cleanup_attempts = ?,
                cleanup_next_attempt_at = ?,
                cleanup_last_error = ?,
                updated_at = ?
          WHERE tailnet_id = ? AND relay_id = ?`,
          [attempts, nextAttemptAt, error, now, networkId, relayId]
        )
        yield* tx.execute(
          `UPDATE ${databaseTable("tailnet")}
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

export const recordTailnetFinalizationFailureEffect = Effect.fn(
  "tailscaleCleanup.finalizationFailure"
)(function* (networkId: string, delaySeconds: number, error: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "tailscaleCleanup.finalizationFailure",
    `UPDATE ${databaseTable("tailnet")}
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
  deployment: PersistedTunnel,
  now: number
) {
  // A tunnel Hearth sees for the first time is its tailnet owner's, and one
  // of the tailnet's group. One of a tailnet Hearth doesn't know is left out.
  return Effect.gen(function* () {
    const result = yield* tx.execute(
      `INSERT INTO ${databaseTable("tunnel")}
         (id, tailnet_id, relay_id, owner_id, state, cleanup_next_attempt_at,
          observed_at, updated_at)
       SELECT ?, tailnet.id, ?, tailnet.owner_id, ?, ?, ?, ?
         FROM ${databaseTable("tailnet")} tailnet
        WHERE tailnet.id = ?
       ON DUPLICATE KEY UPDATE
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
    yield* tx.execute(
      `INSERT IGNORE INTO ${databaseTable("instance_group_member")}
         (instance_id, group_id, instance_kind, relay_id, created_at)
       SELECT ?, tailnet.id, 'tunnel', ?, ?
         FROM ${databaseTable("tailnet")} tailnet
        WHERE tailnet.id = ?`,
      [deployment.id, deployment.relayId, now, deployment.tailnetId]
    )
    return result
  })
}

function parseDeployment(
  value: unknown,
  tunnelId: string,
  relayId: string
): PersistedTunnel {
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
  if (stack.id !== tunnelId) {
    throw new Error("Stored tunnel belongs to another tunnel")
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
