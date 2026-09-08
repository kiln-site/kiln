import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import {
  builtinPresetSelections,
  expandPermissionSelections,
  type AccessPermission,
  type PermissionSelection,
} from "@workspace/contracts"
import { Database, type DatabaseTransaction } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { isAccountEnabled, isAccountVerified } from "@/lib/account-policy"
import { databaseTable } from "@/lib/database-config"
import {
  loadResourceGrantsEffect,
  deduplicatePermissionSelections,
  effectiveScopePermissions,
  type ResourceScope,
} from "@/lib/resource-permissions"
import { advanceAuthorizationRevisionEffect } from "@/lib/authorization-revision"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

interface PolicyUserRow extends RowDataPacket {
  role: string | null
  status: "enabled" | "disabled"
  statusExpiresAt: Date | null
  emailVerifiedAt: Date | null
  manuallyVerifiedAt: Date | null
  legacyVerificationRecordedAt: Date | null
}
interface TargetRow extends RowDataPacket {
  engine?: string

  name: string | null
  owner_id: string | null
}
interface SelectionRow extends RowDataPacket {
  selection_kind: "permission" | "collection"
  selection_key: string
}
export interface AccessAssignment {
  selections: Array<PermissionSelection>
  presetIds: Array<string>
  builtinKeys: Array<string>
}

/** Serialize policy edits at their Relay; reads never acquire this write lock. */
export function lockAccessActorEffect(
  transaction: DatabaseTransaction,
  user: AuthenticatedUser
) {
  return Effect.gen(function* () {
    if (user.isDevelopmentBypass) return user
    const rows = yield* transaction.queryRows<PolicyUserRow>(
      `SELECT role, status, statusExpiresAt, emailVerifiedAt, manuallyVerifiedAt, legacyVerificationRecordedAt
         FROM ${databaseTable("user")} WHERE id = ? FOR UPDATE`,
      [user.id]
    )
    const row = rows[0]
    if (!row)
      return yield* Effect.fail(new Error("Your account is unavailable"))
    const actor: AuthenticatedUser = {
      ...user,
      role:
        row.role === "admin" || row.role === "relay_creator"
          ? row.role
          : "user",
      status:
        row.status === "disabled" &&
        (!row.statusExpiresAt || row.statusExpiresAt.getTime() > Date.now())
          ? "disabled"
          : "enabled",
      statusExpiresAt: row.statusExpiresAt?.toISOString() ?? null,
      emailVerifiedAt: row.emailVerifiedAt?.toISOString() ?? null,
      manuallyVerifiedAt: row.manuallyVerifiedAt?.toISOString() ?? null,
      legacyVerificationRecordedAt:
        row.legacyVerificationRecordedAt?.toISOString() ?? null,
    }
    if (!isAccountEnabled(actor) || !isAccountVerified(actor))
      return yield* Effect.fail(
        new Error("Your account cannot manage resource access")
      )
    return actor
  })
}

export function lockAccessScopeEffect(
  transaction: DatabaseTransaction,
  scope: ResourceScope
) {
  return Effect.gen(function* () {
    const relays = yield* transaction.queryRows<TargetRow>(
      `SELECT name, created_by AS owner_id FROM ${databaseTable("relay")} WHERE id = ? FOR UPDATE`,
      [scope.relayId]
    )
    if (!relays[0]) return yield* Effect.fail(new Error("Resource not found"))
    if (scope.resourceType === "relay") {
      if (scope.resourceId !== scope.relayId)
        return yield* Effect.fail(new Error("Invalid Relay scope"))
      return relays[0]
    }
    const rows = yield* transaction.queryRows<TargetRow>(
      scope.resourceType === "instance"
        ? `SELECT COALESCE(display_name, source_name) AS name, owner_id FROM ${databaseTable("instance")} WHERE relay_id = ? AND instance_id = ? FOR UPDATE`
        : `SELECT name, engine, created_by AS owner_id FROM ${databaseTable("database")} WHERE relay_id = ? AND database_id = ? FOR UPDATE`,
      [scope.relayId, scope.resourceId]
    )
    if (!rows[0]) return yield* Effect.fail(new Error("Resource not found"))
    return rows[0]
  })
}

export function scopeAuthorityEffect(
  transaction: DatabaseTransaction,
  actor: AuthenticatedUser,
  scope: ResourceScope,
  permission: AccessPermission
) {
  return Effect.gen(function* () {
    const permissions =
      actor.isDevelopmentBypass || actor.role === "admin"
        ? new Set(
            expandPermissionSelections(
              [{ kind: "collection", key: "all" }],
              scope.resourceType
            )
          )
        : effectiveScopePermissions(
            yield* loadResourceGrantsEffect(
              actor.id,
              scope.relayId,
              transaction,
              scope
            ),
            scope
          )
    if (!permissions.has(permission))
      return yield* Effect.fail(
        new Error("You do not have permission to manage this resource")
      )
    return permissions
  })
}

export function resolveAssignmentEffect(
  transaction: DatabaseTransaction,
  scope: ResourceScope,
  assignment: AccessAssignment
) {
  return Effect.gen(function* () {
    const capabilities = yield* scopeCapabilitiesEffect(transaction, scope)
    const selections = [...assignment.selections]
    const builtins = yield* Effect.try({
      try: () =>
        [...new Set(assignment.builtinKeys)].flatMap((key) =>
          builtinPresetSelections(key, scope.resourceType)
        ),
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Invalid built-in permission preset"),
    })
    selections.push(...builtins)
    for (const id of new Set(assignment.presetIds)) {
      const presets = yield* transaction.queryRows<RowDataPacket>(
        `SELECT id FROM ${databaseTable("permission_preset")} WHERE id = ? AND relay_id = ? AND resource_type = ? AND resource_id = ?`,
        [id, scope.relayId, scope.resourceType, scope.resourceId]
      )
      if (!presets[0])
        return yield* Effect.fail(
          new Error(
            "Presets must belong to this resource; copy a preset to reuse it here"
          )
        )
      const rows = yield* transaction.queryRows<SelectionRow>(
        `SELECT selection_kind, selection_key FROM ${databaseTable("preset_selection")} WHERE preset_id = ?`,
        [id]
      )
      selections.push(
        ...rows.map((row) => ({
          kind: row.selection_kind,
          key: row.selection_key,
        }))
      )
    }
    return yield* Effect.try({
      try: () =>
        expandPermissionSelections(
          deduplicatePermissionSelections(selections),
          scope.resourceType,
          capabilities
        ),
      catch: (cause) =>
        cause instanceof Error
          ? cause
          : new Error("Invalid permission selection"),
    })
  })
}

export function assertDelegation(
  permissions: ReadonlySet<AccessPermission>,
  proposed: ReadonlyArray<AccessPermission>,
  previous: ReadonlyArray<AccessPermission> = []
) {
  const existing = new Set(previous)
  const denied = proposed.filter(
    (key) => !existing.has(key) && !permissions.has(key)
  )
  if (denied.length)
    throw new Error(
      `You cannot grant permissions you do not have: ${denied.join(", ")}`
    )
}

export function writeAccessAssignmentEffect(
  transaction: DatabaseTransaction,
  accessId: string,
  assignment: AccessAssignment,
  actorId: string
) {
  return Effect.gen(function* () {
    yield* transaction.execute(
      `DELETE FROM ${databaseTable("access_selection")} WHERE access_id = ?`,
      [accessId]
    )
    yield* transaction.execute(
      `DELETE FROM ${databaseTable("access_preset")} WHERE access_id = ?`,
      [accessId]
    )
    for (const selection of new Map(
      assignment.selections.map((item) => [`${item.kind}:${item.key}`, item])
    ).values()) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("access_selection")} (access_id, selection_kind, selection_key) VALUES (?, ?, ?)`,
        [accessId, selection.kind, selection.key]
      )
    }
    for (const id of new Set(assignment.presetIds)) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("access_preset")} (id, access_id, preset_id, granted_by) VALUES (?, ?, ?, ?)`,
        [randomUUID(), accessId, id, actorId]
      )
    }
    for (const key of new Set(assignment.builtinKeys)) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("access_preset")} (id, access_id, builtin_key, granted_by) VALUES (?, ?, ?, ?)`,
        [randomUUID(), accessId, key, actorId]
      )
    }
  })
}

export function auditAccessEffect(
  transaction: DatabaseTransaction,
  actorId: string,
  event: string,
  metadata: Record<string, unknown>
) {
  return transaction.execute(
    `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, ?, ?)`,
    [actorId, event, JSON.stringify(metadata)]
  )
}

export function advanceScopeAccessEffect(
  transaction: DatabaseTransaction,
  userId: string,
  scope: ResourceScope
) {
  return advanceAuthorizationRevisionEffect(transaction, {
    userId,
    targets: [
      {
        relayId: scope.relayId,
        scope:
          scope.resourceType === "instance"
            ? { kind: "instance", instanceId: scope.resourceId }
            : { kind: "subject_relay" },
      },
    ],
  })
}

export async function publishResourceAccessChange(
  userIds: Array<string>,
  relayIds: Array<string>
) {
  publishRealtimeChange({
    type: "access.changed",
    reauthenticate: false,
    userIds: [...new Set(userIds)],
  })
  const { wakeAuthorizationDelivery } =
    await import("@/lib/authorization-delivery")
  for (const relayId of new Set(relayIds)) wakeAuthorizationDelivery(relayId)
  publishRealtimeChange({
    type: "hearth.invalidate",
    audience: { kind: "relays", relayIds: [...new Set(relayIds)] },
    topics: ["access"],
  })
}

export function accessPolicyTransaction<TResult, TError, TRequirements>(
  name: string,
  run: (
    tx: DatabaseTransaction
  ) => Effect.Effect<TResult, TError, TRequirements>
) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction(name, run)
  })
}

export function scopeCapabilitiesEffect(
  transaction: DatabaseTransaction,
  scope: ResourceScope
) {
  return Effect.gen(function* () {
    if (scope.resourceType !== "database") return undefined
    const rows = yield* transaction.queryRows<
      RowDataPacket & { engine: string }
    >(
      `SELECT engine FROM ${databaseTable("database")} WHERE relay_id = ? AND database_id = ?`,
      [scope.relayId, scope.resourceId]
    )
    if (!rows[0]) return yield* Effect.fail(new Error("Resource not found"))
    return ["mysql", "mariadb", "postgres"].includes(rows[0].engine)
      ? ["database.logical-backups"]
      : []
  })
}
