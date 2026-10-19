import { randomUUID } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Predicate } from "effect"

import {
  appIdFromFileRoot,
  isRelayFileRoot,
  relayOperationRetentionMs,
} from "@workspace/contracts"
import type {
  RelayControlOperation,
  RelayOperationLookup,
} from "@workspace/contracts"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

/**
 * Hearth's audit of changes: who asked for what, on which resource, and how
 * it went. `relayRpc` records every change it sends a Relay. The table also
 * fits changes Hearth makes on its own, which can record themselves the same
 * way as they move onto it.
 */

export type AuditOutcome =
  | "failed"
  | "not_run"
  | "pending"
  | "succeeded"
  | "unknown"

export interface AuditActor {
  readonly kind: "cli" | "system" | "user"
  readonly credentialId: string | null
  readonly userId: string | null
}

export interface AuditTarget {
  readonly id: string
  readonly kind: string
}

export interface AuditEvent {
  readonly action: string
  readonly actor: AuditActor
  readonly details: Readonly<Record<string, string>> | null
  readonly errorCode: string | null
  readonly finishedAt: number | null
  readonly id: string
  readonly occurredAt: number
  readonly operationId: string | null
  readonly outcome: AuditOutcome
  readonly relayId: string | null
  readonly target: AuditTarget
}

/**
 * The actor a Relay request's subject names: a user, a CLI credential acting
 * for a user (`cli/<credential>/<user>`), or Hearth itself.
 */
export function auditActorForSubject(subject: string | undefined): AuditActor {
  if (!subject) return { credentialId: null, kind: "system", userId: null }
  const cli = /^cli\/([^/]+)\/(.+)$/u.exec(subject)
  return cli
    ? { credentialId: cli[1]!, kind: "cli", userId: cli[2]! }
    : { credentialId: null, kind: "user", userId: subject }
}

/** The resource a Relay change acts on, read from its payload. */
export function relayChangeTarget(
  relayId: string,
  operation: RelayControlOperation,
  payload: unknown
): AuditTarget {
  const field = (name: string) =>
    Predicate.isObject(payload) &&
    Predicate.isString((payload as Record<string, unknown>)[name])
      ? ((payload as Record<string, unknown>)[name] as string)
      : null
  const nested =
    Predicate.isObject(payload) &&
    Predicate.isObject((payload as Record<string, unknown>).target)
      ? ((payload as Record<string, unknown>).target as Record<string, unknown>)
      : null
  if (
    nested &&
    Predicate.isString(nested.kind) &&
    Predicate.isString(nested.id)
  ) {
    return { id: nested.id, kind: nested.kind }
  }
  const [area] = operation.split(".")
  if (area === "instance") {
    // File operations take a file root: a game server's, an App's, or the
    // Relay's own host files.
    const id = field("instanceId")
    if (id) {
      const appId = appIdFromFileRoot(id)
      if (appId) return { id: appId, kind: "app" }
      if (isRelayFileRoot(id)) return { id: relayId, kind: "relay" }
      return { id, kind: "instance" }
    }
  }
  if (area === "app") {
    const id = field("appId") ?? field("id")
    if (id) return { id, kind: "app" }
  }
  if (area === "database") {
    const id = field("databaseId") ?? field("id")
    if (id) return { id, kind: "database" }
  }
  return { id: relayId, kind: "relay" }
}

// Only short, non-secret fields that say what a change was, such as the
// power action; payloads can carry file contents and credentials.
function safeDetails(payload: unknown): Record<string, string> | null {
  if (!Predicate.isObject(payload)) return null
  const record = payload as Record<string, unknown>
  const details: Record<string, string> = {}
  for (const key of ["action", "kind", "mode"]) {
    const value = record[key]
    if (Predicate.isString(value) && value.length <= 64) details[key] = value
  }
  return Object.keys(details).length ? details : null
}

/** Records a Relay change as pending, before it's sent. */
export const recordRelayChangeStarted = Effect.fn(
  "audit.recordRelayChangeStarted"
)(function* (input: {
  readonly operation: RelayControlOperation
  readonly operationId: string
  readonly payload: unknown
  readonly relayId: string
  readonly subject: string | undefined
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const actor = auditActorForSubject(input.subject)
  const target = relayChangeTarget(
    input.relayId,
    input.operation,
    input.payload
  )
  const details = safeDetails(input.payload)
  yield* database.execute(
    "audit.recordRelayChangeStarted",
    `INSERT INTO ${databaseTable("audit_event")}
       (id, occurred_at, actor_kind, actor_user_id, actor_credential_id,
        action, target_kind, target_id, relay_id, operation_id, outcome,
        details)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
    [
      randomUUID(),
      now,
      actor.kind,
      actor.userId,
      actor.credentialId,
      input.operation,
      target.kind,
      target.id.slice(0, 128),
      input.relayId,
      input.operationId,
      details ? JSON.stringify(details) : null,
    ]
  )
})

/**
 * Gives a pending Relay change its outcome. Settled ones are kept as they are.
 * A failure keeps only its code: error messages can repeat what was sent,
 * such as a password a database refused.
 */
export const recordRelayChangeFinished = Effect.fn(
  "audit.recordRelayChangeFinished"
)(function* (input: {
  readonly errorCode?: string | undefined
  readonly operationId: string
  readonly outcome: Exclude<AuditOutcome, "pending">
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "audit.recordRelayChangeFinished",
    `UPDATE ${databaseTable("audit_event")}
        SET outcome = ?, finished_at = ?, error_code = ?
      WHERE operation_id = ? AND outcome = 'pending'`,
    [
      input.outcome,
      now,
      input.errorCode?.slice(0, 64) ?? null,
      input.operationId,
    ]
  )
})

interface PendingRow extends RowDataPacket {
  id: string
  occurred_at: number | string
  operation_id: string
}

const RECONCILE_PAGE = 200
// A Relay forgets a change a while after it finishes. Past that, less a
// margin for the two clocks, its not knowing one says nothing.
const RELAY_REMEMBERS_MS = relayOperationRetentionMs - 24 * 60 * 60_000

/**
 * Settles changes left pending on a Relay, such as by a Hearth restart, by
 * asking the Relay how each went. Changes younger than `olderThan` may still
 * be awaited by this process and are left alone. Returns how many it couldn't
 * settle yet, because they're still running or the Relay didn't answer.
 */
export const reconcilePendingRelayChanges = Effect.fn(
  "audit.reconcilePendingRelayChanges"
)(function* (
  relayId: string,
  olderThan: number,
  lookup: (operationId: string) => Effect.Effect<RelayOperationLookup, unknown>
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  let unsettled = 0
  let after: { readonly id: string; readonly occurredAt: number } | null = null
  while (true) {
    const rows: ReadonlyArray<PendingRow> =
      yield* database.queryRows<PendingRow>(
        "audit.pendingRelayChanges",
        `SELECT id, occurred_at, operation_id
         FROM ${databaseTable("audit_event")}
        WHERE relay_id = ? AND outcome = 'pending' AND occurred_at < ?
          ${after ? "AND (occurred_at > ? OR (occurred_at = ? AND id > ?))" : ""}
        ORDER BY occurred_at, id
        LIMIT ${RECONCILE_PAGE}`,
        [
          relayId,
          olderThan,
          ...(after ? [after.occurredAt, after.occurredAt, after.id] : []),
        ]
      )
    for (const row of rows) {
      const answer = yield* lookup(row.operation_id).pipe(Effect.option)
      if (answer._tag === "None" || answer.value.status === "running") {
        unsettled += 1
        continue
      }
      const outcome = answer.value
      const remembered = Number(row.occurred_at) > now - RELAY_REMEMBERS_MS
      yield* recordRelayChangeFinished({
        operationId: row.operation_id,
        ...(outcome.status === "succeeded"
          ? { outcome: "succeeded" as const }
          : outcome.status === "failed"
            ? {
                errorCode: outcome.code,
                outcome:
                  outcome.code === "operation_withdrawn"
                    ? ("not_run" as const)
                    : ("failed" as const),
              }
            : outcome.status === "unknown" && remembered
              ? { outcome: "not_run" as const }
              : { outcome: "unknown" as const }),
      })
    }
    const last = rows.at(-1)
    if (rows.length < RECONCILE_PAGE || !last) return unsettled
    after = { id: last.id, occurredAt: Number(last.occurred_at) }
  }
})

interface AuditRow extends RowDataPacket {
  action: string
  actor_credential_id: string | null
  actor_kind: AuditActor["kind"]
  actor_user_id: string | null
  details: unknown
  error_code: string | null
  finished_at: number | string | null
  id: string
  occurred_at: number | string
  operation_id: string | null
  outcome: AuditOutcome
  relay_id: string | null
  target_id: string
  target_kind: string
}

/** The newest audit events, optionally for one target, newest first. */
export const listAuditEvents = Effect.fn("audit.list")(function* (options: {
  readonly limit: number
  readonly target?: AuditTarget
}) {
  const database = yield* Database
  const rows = yield* database.queryRows<AuditRow>(
    "audit.list",
    `SELECT * FROM ${databaseTable("audit_event")}
      ${options.target ? "WHERE target_kind = ? AND target_id = ?" : ""}
      ORDER BY occurred_at DESC, id DESC
      LIMIT ?`,
    [
      ...(options.target ? [options.target.kind, options.target.id] : []),
      Math.min(Math.max(options.limit, 1), 500),
    ]
  )
  return rows.map((row): AuditEvent => ({
    action: row.action,
    actor: {
      credentialId: row.actor_credential_id,
      kind: row.actor_kind,
      userId: row.actor_user_id,
    },
    details: Predicate.isObject(row.details)
      ? (row.details as Record<string, string>)
      : null,
    errorCode: row.error_code,
    finishedAt: row.finished_at === null ? null : Number(row.finished_at),
    id: row.id,
    occurredAt: Number(row.occurred_at),
    operationId: row.operation_id,
    outcome: row.outcome,
    relayId: row.relay_id,
    target: { id: row.target_id, kind: row.target_kind },
  }))
})
