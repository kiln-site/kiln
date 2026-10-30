import { createHash, randomUUID } from "node:crypto"
import { Clock, Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import {
  builtinPresetSelections,
  expandPermissionSelections,
  type AccessPermission,
  type PermissionSelection,
} from "@workspace/contracts"
import { Database, type DatabaseTransaction } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  accountPolicyFromRow,
  isAccountEnabled,
  isAccountVerified,
} from "@/lib/account-policy"
import { databaseTable } from "@/lib/database-config"
import {
  databaseScopeCapabilities,
  loadResourceGrantsEffect,
  deduplicatePermissionSelections,
  effectiveScopePermissions,
  expandStoredSelections,
  type ResolvedAccessGrant,
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
      ...accountPolicyFromRow(row),
    }
    if (!isAccountEnabled(actor) || !isAccountVerified(actor))
      return yield* Effect.fail(
        new Error("Your account cannot manage resource access")
      )
    return actor
  })
}

/**
 * The one order to lock several scopes in, so transactions that lock more
 * than one queue behind each other rather than deadlock.
 */
export function compareAccessScopes(
  left: ResourceScope,
  right: ResourceScope
): number {
  return JSON.stringify([
    left.relayId,
    left.resourceType,
    left.resourceId,
  ]).localeCompare(
    JSON.stringify([right.relayId, right.resourceType, right.resourceId])
  )
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
        : scope.resourceType === "database"
          ? `SELECT name, engine, owner_id FROM ${databaseTable("database")} WHERE relay_id = ? AND database_id = ? FOR UPDATE`
          : `SELECT name, owner_id FROM ${databaseTable("app")} WHERE relay_id = ? AND app_id = ? FOR UPDATE`,
      [scope.relayId, scope.resourceId]
    )
    if (!rows[0]) return yield* Effect.fail(new Error("Resource not found"))
    return rows[0]
  })
}

/**
 * The actor's effective authority at a scope, checked for one management
 * permission. Pass `grants` (the actor's grants for the scope's Relay, loaded
 * inside the same transaction) to avoid reloading per target in bulk edits.
 */
export function scopeAuthorityEffect(
  // None to check before a change takes its transaction.
  transaction: DatabaseTransaction | undefined,
  actor: AuthenticatedUser,
  scope: ResourceScope,
  permission: AccessPermission,
  grants?: ReadonlyArray<
    Pick<
      ResolvedAccessGrant,
      "relayId" | "resourceType" | "resourceId" | "permissions"
    >
  >
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
            grants ??
              (yield* loadResourceGrantsEffect(
                actor.id,
                scope.relayId,
                transaction,
                scope
              )),
            scope
          )
    if (!permissions.has(permission))
      return yield* Effect.fail(
        new Error("You do not have permission to manage this resource")
      )
    return permissions
  })
}

/** `stored` expands a persisted assignment, tolerating keys the catalog no longer supports here. */
export function resolveAssignmentEffect(
  transaction: DatabaseTransaction,
  scope: ResourceScope,
  assignment: AccessAssignment,
  options: { stored?: boolean } = {}
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
        options.stored
          ? expandStoredSelections(selections, scope.resourceType, capabilities)
          : expandPermissionSelections(
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
    const now = yield* Clock.currentTimeMillis
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
        `INSERT INTO ${databaseTable("access_preset")} (id, access_id, preset_id, granted_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), accessId, id, actorId, now]
      )
    }
    for (const key of new Set(assignment.builtinKeys)) {
      yield* transaction.execute(
        `INSERT INTO ${databaseTable("access_preset")} (id, access_id, builtin_key, granted_by, created_at) VALUES (?, ?, ?, ?, ?)`,
        [randomUUID(), accessId, key, actorId, now]
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
  return Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    return yield* transaction.execute(
      `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata, created_at) VALUES (?, ?, ?, ?)`,
      [actorId, event, JSON.stringify(metadata), now]
    )
  })
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
  // Readers of each Relay refresh only that Relay's access records; the
  // platform user and invitation lists are an administrator concern.
  for (const relayId of new Set(relayIds))
    publishRealtimeChange({
      type: "hearth.invalidate",
      audience: { kind: "relays", relayIds: [relayId] },
      scope: { relayId },
      topics: ["access"],
    })
  publishRealtimeChange({
    type: "hearth.invalidate",
    audience: { kind: "platform-admins" },
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
    return databaseScopeCapabilities(rows[0].engine)
  })
}

interface CopiedPresetRow extends RowDataPacket {
  id: string
  name: string
}
interface CopiedGrantRow extends RowDataPacket {
  id: string
  role: string | null
  user_id: string
}
interface CopiedAccessPresetRow extends RowDataPacket {
  builtin_key: string | null
  preset_id: string | null
}

// A UUID (version 8) derived from a preset and the server it's copied to.
function copiedPresetId(presetId: string, to: ResourceScope): string {
  const hex = createHash("sha256")
    .update(`${presetId}\0${to.relayId}\0${to.resourceId}`)
    .digest("hex")
  const variant = (
    (Number.parseInt(hex.slice(16, 17), 16) & 0x3) |
    0x8
  ).toString(16)
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

/**
 * Gives a new game server the access its source had: the same people, with
 * the same permissions and presets. Presets belong to one resource, so the
 * source's are copied to the new server. Pending invitations aren't copied,
 * since their links can't be, and the new server's owner owns it rather
 * than being granted access. Someone who already has access to the new
 * server keeps what they have. Returns the people given access.
 */
export function copyInstanceAccessEffect(input: {
  readonly actorId: string
  readonly from: { readonly instanceId: string; readonly relayId: string }
  readonly to: { readonly instanceId: string; readonly relayId: string }
}) {
  const fromScope: ResourceScope = {
    relayId: input.from.relayId,
    resourceId: input.from.instanceId,
    resourceType: "instance",
  }
  const toScope: ResourceScope = {
    relayId: input.to.relayId,
    resourceId: input.to.instanceId,
    resourceType: "instance",
  }
  return accessPolicyTransaction("access.copyInstance", (transaction) =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      // Locked in one order whichever way the copy goes, so copies in
      // opposite directions between two Relays queue rather than deadlock.
      const fromFirst = compareAccessScopes(fromScope, toScope) <= 0
      const first = yield* lockAccessScopeEffect(
        transaction,
        fromFirst ? fromScope : toScope
      )
      const second = yield* lockAccessScopeEffect(
        transaction,
        fromFirst ? toScope : fromScope
      )
      const target = fromFirst ? second : first
      const presets = yield* transaction.queryRows<CopiedPresetRow>(
        `SELECT id, name FROM ${databaseTable("permission_preset")}
          WHERE relay_id = ? AND resource_type = 'instance' AND resource_id = ?`,
        [fromScope.relayId, fromScope.resourceId]
      )
      const presetIds = new Map<string, string>()
      for (const preset of presets) {
        // The same ID each time for the same preset and server, so copying
        // again, as a migration resumed mid-step does, adds no second one.
        const id = copiedPresetId(preset.id, toScope)
        presetIds.set(preset.id, id)
        const inserted = yield* transaction.execute(
          `INSERT IGNORE INTO ${databaseTable("permission_preset")}
             (id, relay_id, resource_type, resource_id, name, created_by,
              updated_by, created_at, updated_at)
           VALUES (?, ?, 'instance', ?, ?, ?, ?, ?, ?)`,
          [
            id,
            toScope.relayId,
            toScope.resourceId,
            preset.name,
            input.actorId,
            input.actorId,
            now,
            now,
          ]
        )
        if (inserted.affectedRows === 0) continue
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("preset_selection")}
             (preset_id, selection_kind, selection_key)
           SELECT ?, selection_kind, selection_key
             FROM ${databaseTable("preset_selection")} WHERE preset_id = ?`,
          [id, preset.id]
        )
      }
      const grants = yield* transaction.queryRows<CopiedGrantRow>(
        `SELECT id, user_id, role FROM ${databaseTable("access_grant")}
          WHERE relay_id = ? AND resource_type = 'instance'
            AND resource_id = ? AND state = 'active'`,
        [fromScope.relayId, fromScope.resourceId]
      )
      const copiedTo: Array<string> = []
      for (const grant of grants) {
        if (grant.user_id === target.owner_id) continue
        const id = randomUUID()
        const inserted = yield* transaction.execute(
          `INSERT IGNORE INTO ${databaseTable("access_grant")}
             (id, user_id, relay_id, resource_type, resource_id, role, state,
              granted_by, created_at, updated_at)
           VALUES (?, ?, ?, 'instance', ?, ?, 'active', ?, ?, ?)`,
          [
            id,
            grant.user_id,
            toScope.relayId,
            toScope.resourceId,
            grant.role,
            input.actorId,
            now,
            now,
          ]
        )
        if (inserted.affectedRows === 0) continue
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("access_selection")}
             (access_id, selection_kind, selection_key)
           SELECT ?, selection_kind, selection_key
             FROM ${databaseTable("access_selection")} WHERE access_id = ?`,
          [id, grant.id]
        )
        const assigned = yield* transaction.queryRows<CopiedAccessPresetRow>(
          `SELECT preset_id, builtin_key FROM ${databaseTable("access_preset")}
            WHERE access_id = ?`,
          [grant.id]
        )
        for (const preset of assigned) {
          const presetId = preset.preset_id
            ? (presetIds.get(preset.preset_id) ?? null)
            : null
          if (preset.preset_id && !presetId) continue
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("access_preset")}
               (id, access_id, preset_id, builtin_key, granted_by, created_at)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [randomUUID(), id, presetId, preset.builtin_key, input.actorId, now]
          )
        }
        yield* advanceScopeAccessEffect(transaction, grant.user_id, toScope)
        copiedTo.push(grant.user_id)
      }
      yield* auditAccessEffect(transaction, input.actorId, "access.copied", {
        from: fromScope,
        people: copiedTo.length,
        to: toScope,
      })
      return copiedTo
    })
  )
}
