import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import type { DatabaseTransaction } from "@/effect/database"
import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export type AuthorizationScope =
  | { instanceId: string; kind: "instance" }
  | { kind: "login_session"; loginSessionId: string }
  | { kind: "subject_relay" }

export interface AuthorizationDeliveryTarget {
  relayId: string
  scope: AuthorizationScope
}

interface RevisionRow extends RowDataPacket {
  revision: string
}

interface RelayIdRow extends RowDataPacket {
  id: string
}

export interface AuthorizationRevisionChange {
  relayIds: ReadonlyArray<string>
  revision: number
}

export function enabledRelayTargetsEffect(
  transaction: DatabaseTransaction,
  scope: AuthorizationScope
) {
  return Effect.gen(function* () {
    const relays = yield* transaction.queryRows<RelayIdRow>(
      `SELECT id FROM ${databaseTable("relay")} WHERE enabled = TRUE`
    )
    return relays.map((relay) => ({ relayId: relay.id, scope }))
  })
}

/**
 * Advances a subject revision and writes its delivery intent in the caller's
 * transaction. Callers must only wake delivery after that transaction commits.
 */
export function advanceAuthorizationRevisionEffect(
  transaction: DatabaseTransaction,
  input: {
    targets: ReadonlyArray<AuthorizationDeliveryTarget>
    userId: string
  }
) {
  return Effect.gen(function* () {
    yield* transaction.execute(
      `INSERT INTO ${databaseTable("authorization_subject")} (user_id, revision)
       VALUES (?, 0)
       ON DUPLICATE KEY UPDATE user_id = VALUES(user_id)`,
      [input.userId]
    )
    const rows = yield* transaction.queryRows<RevisionRow>(
      `SELECT CAST(revision AS CHAR) AS revision
         FROM ${databaseTable("authorization_subject")}
        WHERE user_id = ?
        FOR UPDATE`,
      [input.userId]
    )
    const current = Number(rows[0]?.revision ?? "0")
    const revision = current + 1
    if (!Number.isSafeInteger(revision)) {
      return yield* Effect.fail(
        new Error("Authorization revision exceeded the safe integer range")
      )
    }
    yield* transaction.execute(
      `UPDATE ${databaseTable("authorization_subject")}
          SET revision = ?
        WHERE user_id = ?`,
      [revision, input.userId]
    )

    const targets = deduplicateTargets(input.targets)
    for (const target of targets) {
      const [scopeKind, scopeId] = encodeScope(target.scope)
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("authorization_delivery")}
           (relay_id, subject_id, scope_kind, scope_id, desired_revision)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           desired_revision = GREATEST(desired_revision, VALUES(desired_revision))`,
        [target.relayId, input.userId, scopeKind, scopeId, revision]
      )
    }
    return {
      relayIds: [...new Set(targets.map((target) => target.relayId))],
      revision,
    } satisfies AuthorizationRevisionChange
  }).pipe(
    Effect.withSpan("hearth.authorization.enqueue", {
      attributes: { "authorization.target_count": input.targets.length },
    })
  )
}

export const readAuthorizationRevisionEffect = Effect.fn(
  "authorization.revision.read"
)(function* (userId: string) {
  const database = yield* Database
  const rows = yield* database.queryRows<RevisionRow>(
    "authorization.revision.read",
    `SELECT CAST(revision AS CHAR) AS revision
       FROM ${databaseTable("authorization_subject")}
      WHERE user_id = ?
      LIMIT 1`,
    [userId]
  )
  const revision = Number(rows[0]?.revision ?? "0")
  if (!Number.isSafeInteger(revision)) {
    return yield* Effect.fail(
      new Error("Authorization revision exceeded the safe integer range")
    )
  }
  return revision
})

export function advanceSubjectAcrossEnabledRelaysEffect(
  transaction: DatabaseTransaction,
  userId: string,
  scopes: ReadonlyArray<AuthorizationScope>
) {
  return Effect.gen(function* () {
    const targets = yield* Effect.all(
      scopes.map((scope) => enabledRelayTargetsEffect(transaction, scope)),
      { concurrency: 1 }
    )
    return yield* advanceAuthorizationRevisionEffect(transaction, {
      targets: targets.flat(),
      userId,
    })
  })
}

function deduplicateTargets(
  targets: ReadonlyArray<AuthorizationDeliveryTarget>
): Array<AuthorizationDeliveryTarget> {
  const unique = new Map<string, AuthorizationDeliveryTarget>()
  for (const target of targets) {
    const [kind, id] = encodeScope(target.scope)
    unique.set(`${target.relayId}\0${kind}\0${id}`, target)
  }
  return [...unique.values()]
}

function encodeScope(scope: AuthorizationScope): [string, string] {
  switch (scope.kind) {
    case "instance":
      return [scope.kind, scope.instanceId]
    case "login_session":
      return [scope.kind, scope.loginSessionId]
    case "subject_relay":
      return [scope.kind, ""]
  }
}
