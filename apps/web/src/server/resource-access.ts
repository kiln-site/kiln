import { createHash, randomBytes, randomUUID } from "node:crypto"
import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"
import {
  accessPermissionSupported,
  builtinPermissionPresets,
  builtinPresetSelections,
  expandPermissionSelections,
  permissionCatalog,
  permissionCollections,
  permissionSelectionsSchema,
  permissionScopeTypeSchema,
  relayIdSchema,
  type PermissionSelection,
} from "@workspace/contracts"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { databasePool } from "@/lib/database"
import { kilnPublicUrl } from "@/lib/environment"
import { requireEligibleResourceUser, requireVerifiedUser } from "@/server/auth"
import {
  loadResourceGrantsEffect,
  deduplicatePermissionSelections,
  effectiveScopePermissions,
  type ResourceScope,
} from "@/lib/resource-permissions"
import {
  accessPolicyTransaction,
  lockAccessActorEffect,
  lockAccessScopeEffect,
  scopeAuthorityEffect,
  scopeCapabilitiesEffect,
  resolveAssignmentEffect,
  assertDelegation,
  writeAccessAssignmentEffect,
  advanceScopeAccessEffect,
  auditAccessEffect,
  publishResourceAccessChange,
} from "@/lib/access-policy-mutations"

export const resourceScopeSchema = z.object({
  relayId: relayIdSchema,
  resourceType: permissionScopeTypeSchema,
  resourceId: z.string().min(1).max(64),
})
const assignmentSchema = z.object({
  selections: permissionSelectionsSchema,
  presetIds: z.array(z.uuid()).max(32).default([]),
  builtinKeys: z.array(z.string().max(120)).max(8).default([]),
})
const inviteSchema = z.object({
  email: z.email().transform((v) => v.trim().toLowerCase()),
  targets: z
    .array(resourceScopeSchema.extend(assignmentSchema.shape))
    .min(1)
    .max(25),
})
const currentAttempt =
  "accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL AND expires_at > CURRENT_TIMESTAMP(3)"
const scopeValues = (scope: ResourceScope) => [
  scope.relayId,
  scope.resourceType,
  scope.resourceId,
]
const scopeFromRow = (row: {
  relay_id: string
  resource_type: ResourceScope["resourceType"]
  resource_id: string
}): ResourceScope => ({
  relayId: row.relay_id,
  resourceType: row.resource_type,
  resourceId: row.resource_id,
})
interface UserRow extends RowDataPacket {
  id: string
  email: string
  name: string
}
interface GrantRow extends RowDataPacket {
  id: string
  user_id: string
  state: "pending" | "active" | "revoked"
  revision: number
  relay_id: string
  resource_type: ResourceScope["resourceType"]
  resource_id: string
  email: string
  name: string
  created_at: Date
  updated_at: Date
}
interface SelectionRow extends RowDataPacket {
  selection_kind: "permission" | "collection"
  selection_key: string
}
interface PresetRow extends RowDataPacket {
  id: string
  name: string
  revision: number
  relay_id: string
  resource_type: ResourceScope["resourceType"]
  resource_id: string
  created_at: Date
  updated_at: Date
  assignment_count: number
}
interface AssignmentRow extends RowDataPacket {
  preset_id: string | null
  builtin_key: string | null
}
interface InvitationRow extends RowDataPacket {
  id: string
  access_id: string
  user_id: string
  email: string
  relay_id: string
  resource_type: ResourceScope["resourceType"]
  resource_id: string
  invited_by: string
  accepted_at: Date | null
  accepted_by: string | null
  acceptance_method: string | null
  declined_at: Date | null
  revoked_at: Date | null
  expires_at: Date
  created_at: Date
  resource_name: string | null
  inviter_name: string | null
  relay_name: string | null
  access_type: string
  delivery_status: string
}

export const inviteResourceAccess = createServerFn({ method: "POST" })
  .validator(inviteSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const targets = [...data.targets].sort((a, b) =>
      JSON.stringify(scopeValues(a)).localeCompare(
        JSON.stringify(scopeValues(b))
      )
    )
    if (
      new Set(targets.map((scope) => JSON.stringify(scopeValues(scope))))
        .size !== targets.length
    )
      throw new Error("Choose each resource only once")
    const result = await runAppEffect(
      "access.invite",
      accessPolicyTransaction("access.invite", (tx) =>
        Effect.gen(function* () {
          const actor = yield* lockAccessActorEffect(tx, user)
          // Reserve the same identity for concurrent invitations; never replace credentials or trust.
          yield* tx.execute(
            `INSERT INTO ${databaseTable("user")} (id, name, email, emailVerified, status, role, statusChangedAt, createdAt, updatedAt)
      VALUES (?, ?, ?, FALSE, 'enabled', 'user', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)) ON DUPLICATE KEY UPDATE id = id`,
            [randomUUID(), data.email.split("@")[0]!, data.email]
          )
          const users = yield* tx.queryRows<UserRow>(
            `SELECT id, email, name FROM ${databaseTable("user")} WHERE email = ? FOR UPDATE`,
            [data.email]
          )
          const recipient = users[0]!
          const invitations: Array<{
            id: string
            accessId: string
            scope: ResourceScope
            inviteUrl: string
            expiresAt: string
            resourceName: string
            existing: boolean
          }> = []
          for (const target of targets) {
            const resource = yield* lockAccessScopeEffect(tx, target)
            const authority = yield* scopeAuthorityEffect(
              tx,
              actor,
              target,
              "access.invite"
            )
            const proposed = yield* resolveAssignmentEffect(tx, target, target)
            yield* Effect.try({
              try: () => assertDelegation(authority, proposed),
              catch: (cause) =>
                cause instanceof Error
                  ? cause
                  : new Error("You cannot grant the selected permissions"),
            })
            if (!proposed.length)
              return yield* Effect.fail(
                new Error("Select at least one permission or preset")
              )
            const grants = yield* tx.queryRows<GrantRow>(
              `SELECT id, state FROM ${databaseTable("access_grant")} WHERE user_id = ? AND relay_id = ? AND resource_type = ? AND resource_id = ? FOR UPDATE`,
              [recipient.id, ...scopeValues(target)]
            )
            const existing = grants[0]
            if (
              existing?.state === "active" ||
              resource.owner_id === recipient.id
            ) {
              invitations.push({
                id: existing?.id ?? "",
                accessId: existing?.id ?? "",
                scope: target,
                inviteUrl: "",
                expiresAt: "",
                resourceName: resource.name ?? target.resourceId,
                existing: true,
              })
              continue
            }
            const accessId = existing?.id ?? randomUUID()
            yield* tx.execute(
              `INSERT INTO ${databaseTable("access_grant")} (id, user_id, relay_id, resource_type, resource_id, role, state, granted_by) VALUES (?, ?, ?, ?, ?, 'viewer', 'pending', ?)
        ON DUPLICATE KEY UPDATE state = 'pending', revision = revision + 1, granted_by = VALUES(granted_by)`,
              [accessId, recipient.id, ...scopeValues(target), actor.id]
            )
            yield* writeAccessAssignmentEffect(tx, accessId, target, actor.id)
            yield* tx.execute(
              `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3), cancelled_at = CURRENT_TIMESTAMP(3), cancelled_by = ? WHERE access_id = ? AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
              [actor.id, accessId]
            )
            const id = randomUUID(),
              token = randomBytes(32).toString("base64url"),
              expiresAt = new Date(Date.now() + 7 * 86400000)
            yield* tx.execute(
              `INSERT INTO ${databaseTable("invitation")} (id, token_hash, email, access_id, user_id, access_type, relay_id, instance_id, database_id, role, invited_by, expires_at, delivery_status)
        VALUES (?, ?, ?, ?, ?, 'scoped', ?, ?, ?, 'viewer', ?, ?, 'pending')`,
              [
                id,
                createHash("sha256").update(token).digest("hex"),
                recipient.email,
                accessId,
                recipient.id,
                target.relayId,
                target.resourceType === "instance" ? target.resourceId : null,
                target.resourceType === "database" ? target.resourceId : null,
                actor.id,
                expiresAt,
              ]
            )
            yield* auditAccessEffect(tx, actor.id, "access.invited", {
              userId: recipient.id,
              invitationId: id,
              accessId,
              scope: target,
            })
            const url = new URL("/invite", kilnPublicUrl())
            url.searchParams.set("token", token)
            invitations.push({
              id,
              accessId,
              scope: target,
              inviteUrl: url.toString(),
              expiresAt: expiresAt.toISOString(),
              resourceName: resource.name ?? target.resourceId,
              existing: false,
            })
          }
          return { userId: recipient.id, invitations }
        })
      )
    )
    await publishResourceAccessChange(
      [result.userId],
      targets.map((target) => target.relayId)
    )
    const { deliverAccessInvitations } =
      await import("@/lib/access-invitation-delivery")
    await deliverAccessInvitations(
      result.invitations.flatMap((item) =>
        item.existing
          ? []
          : [
              {
                id: item.id,
                email: data.email,
                inviteUrl: item.inviteUrl,
                resourceName: item.resourceName,
                scope: item.scope.resourceType,
                inviterName: user.name,
              },
            ]
      )
    )
    return result
  })

const invitationSelect = `SELECT i.*, g.resource_type, g.resource_id, COALESCE(s.display_name, s.source_name, d.name, r.name) AS resource_name, u.name AS inviter_name, r.name AS relay_name
  FROM ${databaseTable("invitation")} i
  LEFT JOIN ${databaseTable("user")} u ON u.id = i.invited_by
  LEFT JOIN ${databaseTable("access_grant")} g ON g.id = i.access_id
  LEFT JOIN ${databaseTable("relay")} r ON r.id = i.relay_id
  LEFT JOIN ${databaseTable("instance")} s ON s.relay_id = i.relay_id AND s.instance_id = i.instance_id
  LEFT JOIN ${databaseTable("database")} d ON d.database_id = i.database_id`
function invitationView(row: InvitationRow) {
  return {
    id: row.id,
    accessId: row.access_id,
    userId: row.user_id,
    email: row.email,
    scope: scopeFromRow(row),
    resourceName: row.resource_name ?? row.resource_id,
    inviterName: row.inviter_name ?? "Kiln",
    relayName: row.relay_name ?? "Relay",
    createdAt: row.created_at.toISOString(),
    expiresAt: row.expires_at.toISOString(),
    acceptedAt: row.accepted_at?.toISOString() ?? null,
    acceptedBy: row.accepted_by,
    acceptanceMethod: row.acceptance_method,
    declinedAt: row.declined_at?.toISOString() ?? null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
    deliveryStatus: row.delivery_status,
    pending:
      !row.accepted_at &&
      !row.declined_at &&
      !row.revoked_at &&
      row.expires_at.getTime() > Date.now(),
  }
}

export const getMyInvitations = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const [rows] = await databasePool.query<Array<InvitationRow>>(
      `${invitationSelect} WHERE i.user_id = ? AND i.access_type = 'scoped' AND i.${currentAttempt.replaceAll(" AND ", " AND i.")} AND g.state = 'pending' AND r.enabled = TRUE ORDER BY i.created_at DESC LIMIT 500`,
      [user.id]
    )
    return rows.map(invitationView)
  }
)

export const getResourceInvitation = createServerFn({ method: "GET" })
  .validator(
    z
      .object({
        id: z.uuid().optional(),
        token: z.string().min(32).max(256).optional(),
      })
      .refine((v) => Boolean(v.id) !== Boolean(v.token))
  )
  .handler(async ({ data }) => {
    const user = await requireVerifiedUser()
    const [rows] = await databasePool.query<Array<InvitationRow>>(
      `${invitationSelect} WHERE ${data.id ? "i.id" : "i.token_hash"} = ? LIMIT 1`,
      [data.id ?? createHash("sha256").update(data.token!).digest("hex")]
    )
    const row = rows[0]
    if (
      !row ||
      (row.user_id !== user.id &&
        user.role !== "admin" &&
        !user.isDevelopmentBypass)
    )
      throw new Error("Invitation not found")
    const [direct] = await databasePool.query<Array<SelectionRow>>(
      `SELECT selection_kind, selection_key FROM ${databaseTable("access_selection")} WHERE access_id = ?`,
      [row.access_id]
    )
    const [assigned] = await databasePool.query<
      Array<AssignmentRow & { name: string | null }>
    >(
      `SELECT a.preset_id, a.builtin_key, p.name FROM ${databaseTable("access_preset")} a LEFT JOIN ${databaseTable("permission_preset")} p ON p.id = a.preset_id WHERE a.access_id = ?`,
      [row.access_id]
    )
    const ids = assigned.flatMap((item) =>
      item.preset_id ? [item.preset_id] : []
    )
    const [presets] = ids.length
      ? await databasePool.query<Array<SelectionRow>>(
          `SELECT selection_kind, selection_key FROM ${databaseTable("preset_selection")} WHERE preset_id IN (?)`,
          [ids]
        )
      : [[]]
    const selections = [...direct, ...presets].map((item) => ({
      kind: item.selection_kind,
      key: item.selection_key,
    }))
    for (const item of assigned)
      if (item.builtin_key)
        selections.push(
          ...builtinPresetSelections(item.builtin_key, row.resource_type)
        )
    return {
      ...invitationView(row),
      permissions: expandPermissionSelections(
        deduplicatePermissionSelections(selections),
        row.resource_type
      ),
      presetNames: assigned.map(
        (item) =>
          item.name ??
          builtinPermissionPresets.find(
            (preset) => preset.key === item.builtin_key
          )?.label ??
          "Preset"
      ),
    }
  })

export const decideResourceInvitation = createServerFn({ method: "POST" })
  .validator(
    z.object({
      id: z.uuid(),
      decision: z.enum(["accept", "decline", "cancel"]),
      force: z.boolean().default(false),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const [snapshots] = await databasePool.query<Array<InvitationRow>>(
      `${invitationSelect} WHERE i.id = ?`,
      [data.id]
    )
    const snapshot = snapshots[0]
    if (!snapshot?.access_id) throw new Error("Invitation not found")
    const scope = scopeFromRow(snapshot)
    const result = await runAppEffect(
      "access.invitation.decide",
      accessPolicyTransaction("access.invitation.decide", (tx) =>
        Effect.gen(function* () {
          const actor = yield* lockAccessActorEffect(tx, user)
          yield* lockAccessScopeEffect(tx, scope)
          const rows = yield* tx.queryRows<InvitationRow>(
            `SELECT i.*, g.resource_type, g.resource_id FROM ${databaseTable("invitation")} i JOIN ${databaseTable("access_grant")} g ON g.id = i.access_id WHERE i.id = ? FOR UPDATE`,
            [data.id]
          )
          const invitation = rows[0]!
          const admin = actor.isDevelopmentBypass || actor.role === "admin"
          if (data.force && (!admin || data.decision !== "accept"))
            return yield* Effect.fail(
              new Error(
                "Only platform administrators can accept for another user"
              )
            )
          if (data.decision === "cancel")
            yield* scopeAuthorityEffect(tx, actor, scope, "access.manage")
          else if (!data.force && invitation.user_id !== actor.id)
            return yield* Effect.fail(new Error("Invitation not found"))
          if (invitation.accepted_at && data.decision === "accept")
            return { userId: invitation.user_id, scope, accepted: true }
          if (invitation.declined_at && data.decision === "decline")
            return { userId: invitation.user_id, scope, accepted: false }
          if (
            invitation.accepted_at ||
            invitation.declined_at ||
            invitation.revoked_at ||
            invitation.expires_at.getTime() <= Date.now()
          )
            return yield* Effect.fail(
              new Error("This invitation is no longer pending")
            )
          if (data.decision === "accept") {
            yield* tx.execute(
              `UPDATE ${databaseTable("invitation")} SET accepted_at = CURRENT_TIMESTAMP(3), accepted_by = ?, acceptance_method = ? WHERE id = ?`,
              [actor.id, data.force ? "admin" : "self", data.id]
            )
            yield* tx.execute(
              `UPDATE ${databaseTable("access_grant")} SET state = 'active', revision = revision + 1 WHERE id = ? AND state = 'pending'`,
              [invitation.access_id]
            )
            yield* advanceScopeAccessEffect(tx, invitation.user_id, scope)
          } else {
            yield* tx.execute(
              data.decision === "decline"
                ? `UPDATE ${databaseTable("invitation")} SET declined_at = CURRENT_TIMESTAMP(3) WHERE id = ?`
                : `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3), cancelled_at = CURRENT_TIMESTAMP(3), cancelled_by = ? WHERE id = ?`,
              data.decision === "decline" ? [data.id] : [actor.id, data.id]
            )
          }
          yield* auditAccessEffect(
            tx,
            actor.id,
            `access.invitation.${data.decision}`,
            {
              invitationId: data.id,
              userId: invitation.user_id,
              scope,
              force: data.force,
            }
          )
          return {
            userId: invitation.user_id,
            scope,
            accepted: data.decision === "accept",
          }
        })
      )
    )
    await publishResourceAccessChange([result.userId], [result.scope.relayId])
    return result
  })

export const savePermissionPreset = createServerFn({ method: "POST" })
  .validator(
    resourceScopeSchema.extend({
      id: z.uuid().optional(),
      revision: z.number().int().positive().optional(),
      name: z.string().trim().min(1).max(120),
      selections: permissionSelectionsSchema,
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const result = await runAppEffect(
      "access.preset.save",
      accessPolicyTransaction("access.preset.save", (tx) =>
        Effect.gen(function* () {
          const actor = yield* lockAccessActorEffect(tx, user)
          yield* lockAccessScopeEffect(tx, data)
          const authority = yield* scopeAuthorityEffect(
            tx,
            actor,
            data,
            data.id ? "preset.manage" : "preset.create"
          )
          const capabilities = yield* scopeCapabilitiesEffect(tx, data)
          const proposed = yield* Effect.try({
            try: () =>
              expandPermissionSelections(
                data.selections,
                data.resourceType,
                capabilities
              ),
            catch: (cause) =>
              cause instanceof Error
                ? cause
                : new Error("Invalid permission selection"),
          })
          let previous: Array<PermissionSelection> = []
          if (data.id) {
            const rows = yield* tx.queryRows<PresetRow>(
              `SELECT id, revision FROM ${databaseTable("permission_preset")} WHERE id = ? AND relay_id = ? AND resource_type = ? AND resource_id = ? FOR UPDATE`,
              [data.id, ...scopeValues(data)]
            )
            if (!rows[0])
              return yield* Effect.fail(new Error("Preset not found"))
            if (Number(rows[0].revision) !== data.revision)
              return yield* Effect.fail(
                new Error("This preset changed; refresh before saving")
              )
            const selections = yield* tx.queryRows<SelectionRow>(
              `SELECT selection_kind, selection_key FROM ${databaseTable("preset_selection")} WHERE preset_id = ?`,
              [data.id]
            )
            previous = selections.map((row) => ({
              kind: row.selection_kind,
              key: row.selection_key,
            }))
          }
          yield* Effect.try({
            try: () =>
              assertDelegation(
                authority,
                proposed,
                expandPermissionSelections(previous, data.resourceType)
              ),
            catch: (cause) =>
              cause instanceof Error
                ? cause
                : new Error("You cannot grant the selected permissions"),
          })
          const id = data.id ?? randomUUID()
          if (data.id)
            yield* tx.execute(
              `UPDATE ${databaseTable("permission_preset")} SET name = ?, revision = revision + 1, updated_by = ? WHERE id = ?`,
              [data.name, actor.id, id]
            )
          else
            yield* tx.execute(
              `INSERT INTO ${databaseTable("permission_preset")} (id, relay_id, resource_type, resource_id, name, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [id, ...scopeValues(data), data.name, actor.id, actor.id]
            )
          yield* tx.execute(
            `DELETE FROM ${databaseTable("preset_selection")} WHERE preset_id = ?`,
            [id]
          )
          for (const selection of new Map(
            data.selections.map((item) => [`${item.kind}:${item.key}`, item])
          ).values())
            yield* tx.execute(
              `INSERT INTO ${databaseTable("preset_selection")} (preset_id, selection_kind, selection_key) VALUES (?, ?, ?)`,
              [id, selection.kind, selection.key]
            )
          const affected = yield* tx.queryRows<GrantRow>(
            `SELECT DISTINCT g.user_id FROM ${databaseTable("access_preset")} a JOIN ${databaseTable("access_grant")} g ON g.id = a.access_id WHERE a.preset_id = ? AND g.state = 'active' ORDER BY g.user_id`,
            [id]
          )
          for (const row of affected)
            yield* advanceScopeAccessEffect(tx, row.user_id, data)
          yield* auditAccessEffect(
            tx,
            actor.id,
            data.id ? "access.preset.updated" : "access.preset.created",
            { presetId: id, scope: data, affected: affected.length }
          )
          return { id, userIds: affected.map((row) => row.user_id) }
        })
      )
    )
    await publishResourceAccessChange(result.userIds, [data.relayId])
    return { id: result.id }
  })

export const deletePermissionPreset = createServerFn({ method: "POST" })
  .validator(
    resourceScopeSchema.extend({
      id: z.uuid(),
      revision: z.number().int().positive(),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    await runAppEffect(
      "access.preset.delete",
      accessPolicyTransaction("access.preset.delete", (tx) =>
        Effect.gen(function* () {
          const actor = yield* lockAccessActorEffect(tx, user)
          yield* lockAccessScopeEffect(tx, data)
          yield* scopeAuthorityEffect(tx, actor, data, "preset.manage")
          const used = yield* tx.queryRows<RowDataPacket>(
            `SELECT a.id FROM ${databaseTable("access_preset")} a JOIN ${databaseTable("access_grant")} g ON g.id = a.access_id WHERE a.preset_id = ? AND g.state <> 'revoked' LIMIT 1`,
            [data.id]
          )
          if (used.length)
            return yield* Effect.fail(
              new Error(
                "Remove this preset from its assignments before deleting it"
              )
            )
          yield* tx.execute(
            `DELETE a FROM ${databaseTable("access_preset")} a JOIN ${databaseTable("access_grant")} g ON g.id = a.access_id WHERE a.preset_id = ? AND g.state = 'revoked'`,
            [data.id]
          )
          const result = yield* tx.execute(
            `DELETE FROM ${databaseTable("permission_preset")} WHERE id = ? AND relay_id = ? AND resource_type = ? AND resource_id = ? AND revision = ?`,
            [data.id, ...scopeValues(data), data.revision]
          )
          if (!result.affectedRows)
            return yield* Effect.fail(
              new Error("Preset changed or no longer exists")
            )
          yield* auditAccessEffect(tx, actor.id, "access.preset.deleted", {
            presetId: data.id,
            scope: data,
          })
        })
      )
    )
    await publishResourceAccessChange([], [data.relayId])
    return { deleted: true }
  })

export const updateResourceAccess = createServerFn({ method: "POST" })
  .validator(
    resourceScopeSchema.extend(assignmentSchema.shape).extend({
      id: z.uuid(),
      revision: z.number().int().positive(),
      revoke: z.boolean().default(false),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const result = await runAppEffect(
      "access.update",
      accessPolicyTransaction("access.update", (tx) =>
        Effect.gen(function* () {
          const actor = yield* lockAccessActorEffect(tx, user),
            resource = yield* lockAccessScopeEffect(tx, data)
          const authority = yield* scopeAuthorityEffect(
            tx,
            actor,
            data,
            "access.manage"
          )
          const rows = yield* tx.queryRows<GrantRow>(
            `SELECT * FROM ${databaseTable("access_grant")} WHERE id = ? AND relay_id = ? AND resource_type = ? AND resource_id = ? FOR UPDATE`,
            [data.id, ...scopeValues(data)]
          )
          const grant = rows[0]
          if (!grant) return yield* Effect.fail(new Error("Access not found"))
          if (resource.owner_id === grant.user_id)
            return yield* Effect.fail(
              new Error("Transfer ownership before changing the owner's access")
            )
          if (Number(grant.revision) !== data.revision)
            return yield* Effect.fail(
              new Error("This access changed; refresh before saving")
            )
          if (!data.revoke) {
            const oldSelections = yield* tx.queryRows<SelectionRow>(
              `SELECT selection_kind, selection_key FROM ${databaseTable("access_selection")} WHERE access_id = ?`,
              [grant.id]
            )
            const oldPresets = yield* tx.queryRows<AssignmentRow>(
              `SELECT preset_id, builtin_key FROM ${databaseTable("access_preset")} WHERE access_id = ?`,
              [grant.id]
            )
            const previous = yield* resolveAssignmentEffect(tx, data, {
              selections: oldSelections.map((s) => ({
                kind: s.selection_kind,
                key: s.selection_key,
              })),
              presetIds: oldPresets.flatMap((p) =>
                p.preset_id ? [p.preset_id] : []
              ),
              builtinKeys: oldPresets.flatMap((p) =>
                p.builtin_key ? [p.builtin_key] : []
              ),
            })
            const proposed = yield* resolveAssignmentEffect(tx, data, data)
            yield* Effect.try({
              try: () => assertDelegation(authority, proposed, previous),
              catch: (cause) =>
                cause instanceof Error
                  ? cause
                  : new Error("You cannot grant the selected permissions"),
            })
            yield* writeAccessAssignmentEffect(tx, grant.id, data, actor.id)
          } else {
            yield* tx.execute(
              `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3), cancelled_at = CURRENT_TIMESTAMP(3), cancelled_by = ? WHERE access_id = ? AND accepted_at IS NULL AND declined_at IS NULL AND revoked_at IS NULL`,
              [actor.id, grant.id]
            )
          }
          yield* tx.execute(
            `UPDATE ${databaseTable("access_grant")} SET state = ?, revision = revision + 1 WHERE id = ?`,
            [data.revoke ? "revoked" : grant.state, grant.id]
          )
          yield* advanceScopeAccessEffect(tx, grant.user_id, data)
          yield* auditAccessEffect(
            tx,
            actor.id,
            data.revoke ? "access.revoked" : "access.updated",
            { userId: grant.user_id, accessId: grant.id, scope: data }
          )
          const remaining = data.revoke
            ? effectiveScopePermissions(
                yield* loadResourceGrantsEffect(
                  grant.user_id,
                  data.relayId,
                  tx,
                  data
                ),
                data
              ).size > 0
            : false
          return { userId: grant.user_id, inheritedAccessRemains: remaining }
        })
      )
    )
    await publishResourceAccessChange([result.userId], [data.relayId])
    return result
  })

// Inheritance must be filtered before pagination. Cache the catalog's transitive
// read selectors once per child kind; preset contents remain live SQL lookups.
const inheritedPeopleSelectors = new Map(
  (["instance", "database"] as const).map((scope) => {
    const grantsRead = (selection: PermissionSelection) =>
      expandPermissionSelections([selection], "relay").includes(`${scope}.read`)
    return [
      scope,
      {
        permissions: permissionCatalog.flatMap((entry) =>
          accessPermissionSupported(entry.key, "relay") &&
          grantsRead({ kind: "permission", key: entry.key })
            ? [entry.key]
            : []
        ),
        collections: permissionCollections.flatMap((entry) =>
          entry.scopeTypes.includes("relay") &&
          grantsRead({ kind: "collection", key: entry.key })
            ? [entry.key]
            : []
        ),
        builtins: builtinPermissionPresets.flatMap((entry) =>
          expandPermissionSelections(
            builtinPresetSelections(entry.key, "relay"),
            "relay"
          ).includes(`${scope}.read`)
            ? [entry.key]
            : []
        ),
      },
    ] as const
  })
)

export const getResourceAccess = createServerFn({ method: "GET" })
  .validator(
    resourceScopeSchema.extend({
      offset: z.number().int().min(0).default(0),
      search: z.string().trim().max(256).default(""),
    })
  )
  .handler(async ({ data }) => {
    if (data.resourceType === "relay" && data.resourceId !== data.relayId)
      throw new Error("Resource not found")
    const user = await requireEligibleResourceUser()
    const admin = user.role === "admin" || user.isDevelopmentBypass
    const grants = admin
      ? []
      : await runAppEffect(
          "access.scope",
          loadResourceGrantsEffect(user.id, data.relayId, undefined, data)
        )
    const permissions = admin
      ? expandPermissionSelections(
          [{ kind: "collection", key: "all" }],
          data.resourceType
        )
      : [...effectiveScopePermissions(grants, data)]
    const [engines] =
      data.resourceType === "database"
        ? await databasePool.query<Array<RowDataPacket & { engine: string }>>(
            `SELECT engine FROM ${databaseTable("database")} WHERE relay_id = ? AND database_id = ?`,
            [data.relayId, data.resourceId]
          )
        : [[]]
    const supportedCapabilities =
      data.resourceType === "database"
        ? ["mysql", "mariadb", "postgres"].includes(engines[0]?.engine ?? "")
          ? ["database.logical-backups"]
          : []
        : undefined
    const supportedPermissions = permissions.filter((permission) =>
      accessPermissionSupported(
        permission,
        data.resourceType,
        supportedCapabilities
      )
    )
    if (!supportedPermissions.length) throw new Error("Resource not found")
    const [owners] = await databasePool.query<Array<UserRow>>(
      data.resourceType === "relay"
        ? `SELECT u.id, u.name, u.email FROM ${databaseTable("relay")} r LEFT JOIN ${databaseTable("user")} u ON u.id = r.created_by WHERE r.id = ?`
        : data.resourceType === "instance"
          ? `SELECT u.id, u.name, u.email FROM ${databaseTable("instance")} r LEFT JOIN ${databaseTable("user")} u ON u.id = r.owner_id WHERE r.relay_id = ? AND r.instance_id = ?`
          : `SELECT u.id, u.name, u.email FROM ${databaseTable("database")} r LEFT JOIN ${databaseTable("user")} u ON u.id = r.created_by WHERE r.relay_id = ? AND r.database_id = ?`,
      data.resourceType === "relay"
        ? [data.relayId]
        : [data.relayId, data.resourceId]
    )
    if (!owners.length) throw new Error("Resource not found")
    const canReadPeople = permissions.includes("access.read")
    const inheritedSelectors =
      data.resourceType === "relay"
        ? undefined
        : inheritedPeopleSelectors.get(data.resourceType)
    const readSelection = (alias: string) =>
      `((${alias}.selection_kind = 'permission' AND ${alias}.selection_key IN (?)) OR (${alias}.selection_kind = 'collection' AND ${alias}.selection_key IN (?)))`
    const inheritedFilter = inheritedSelectors
      ? ` OR (g.resource_type = 'relay' AND g.resource_id = g.relay_id AND g.state = 'active' AND (
          EXISTS (SELECT 1 FROM ${databaseTable("access_selection")} s WHERE s.access_id = g.id AND ${readSelection("s")})
          OR EXISTS (SELECT 1 FROM ${databaseTable("access_preset")} a
            JOIN ${databaseTable("permission_preset")} p ON p.id = a.preset_id AND p.relay_id = g.relay_id AND p.resource_type = g.resource_type AND p.resource_id = g.resource_id
            JOIN ${databaseTable("preset_selection")} s ON s.preset_id = p.id
            WHERE a.access_id = g.id AND ${readSelection("s")})
          OR EXISTS (SELECT 1 FROM ${databaseTable("access_preset")} a WHERE a.access_id = g.id AND a.builtin_key IN (?))
        ))`
      : ""
    const peopleSearch = data.search
      ? `%${data.search.replace(/[\\%_]/gu, "\\$&")}%`
      : null
    const [people] = canReadPeople
      ? await databasePool.query<Array<GrantRow>>(
          `SELECT g.*, u.email, u.name FROM ${databaseTable("access_grant")} g JOIN ${databaseTable("user")} u ON u.id = g.user_id WHERE g.relay_id = ? AND ((g.resource_type = ? AND g.resource_id = ?)${inheritedFilter}) AND g.state <> 'revoked'${peopleSearch ? " AND (u.email LIKE ? OR u.name LIKE ?)" : ""} ORDER BY g.created_at, g.id LIMIT 101 OFFSET ?`,
          [
            ...scopeValues(data),
            ...(inheritedSelectors
              ? [
                  inheritedSelectors.permissions,
                  inheritedSelectors.collections,
                  inheritedSelectors.permissions,
                  inheritedSelectors.collections,
                  inheritedSelectors.builtins,
                ]
              : []),
            ...(peopleSearch ? [peopleSearch, peopleSearch] : []),
            data.offset,
          ]
        )
      : [[]]
    const ownAccess = grants.flatMap((grant) =>
      grant.source === "access" &&
      grant.resourceType === data.resourceType &&
      grant.resourceId === data.resourceId
        ? [grant.id]
        : []
    )
    const canReadPresets = permissions.includes("preset.read")
    const [presets] = await databasePool.query<Array<PresetRow>>(
      `SELECT p.*, (SELECT COUNT(*) FROM ${databaseTable("access_preset")} a JOIN ${databaseTable("access_grant")} used ON used.id = a.access_id WHERE a.preset_id = p.id AND used.state <> 'revoked') AS assignment_count FROM ${databaseTable("permission_preset")} p WHERE p.relay_id = ? AND p.resource_type = ? AND p.resource_id = ?${canReadPresets ? "" : ` AND EXISTS (SELECT 1 FROM ${databaseTable("access_preset")} a WHERE a.preset_id = p.id AND a.access_id IN (${ownAccess.length ? ownAccess.map(() => "?").join(",") : "NULL"}))`} ORDER BY p.name, p.id LIMIT 200`,
      [...scopeValues(data), ...(canReadPresets ? [] : ownAccess)]
    )
    const ids = people.slice(0, 100).map((person) => person.id)
    const [selected] = ids.length
      ? await databasePool.query<Array<SelectionRow & { access_id: string }>>(
          `SELECT access_id, selection_kind, selection_key FROM ${databaseTable("access_selection")} WHERE access_id IN (?)`,
          [ids]
        )
      : [[]]
    const [assigned] = ids.length
      ? await databasePool.query<Array<AssignmentRow & { access_id: string }>>(
          `SELECT access_id, preset_id, builtin_key FROM ${databaseTable("access_preset")} WHERE access_id IN (?)`,
          [ids]
        )
      : [[]]
    const presetIds = [
      ...new Set([
        ...presets.map((preset) => preset.id),
        ...assigned.flatMap((assignment) =>
          assignment.preset_id ? [assignment.preset_id] : []
        ),
      ]),
    ]
    const [presetSelections] = presetIds.length
      ? await databasePool.query<Array<SelectionRow & { preset_id: string }>>(
          `SELECT preset_id, selection_kind, selection_key FROM ${databaseTable("preset_selection")} WHERE preset_id IN (?)`,
          [presetIds]
        )
      : [[]]
    const [attempts] = ids.length
      ? await databasePool.query<Array<InvitationRow>>(
          `SELECT * FROM ${databaseTable("invitation")} WHERE access_id IN (?) AND ${currentAttempt} ORDER BY created_at DESC`,
          [ids]
        )
      : [[]]
    return {
      scope: {
        relayId: data.relayId,
        resourceType: data.resourceType,
        resourceId: data.resourceId,
      },
      permissions: supportedPermissions,
      supportedCapabilities,
      canTransferOwnership:
        data.resourceType === "instance" &&
        (admin || owners[0]?.id === user.id),
      owner: owners[0]?.id
        ? {
            id: owners[0].id,
            name: owners[0].name,
            email: permissions.includes("access.read") ? owners[0].email : "",
          }
        : null,
      authorizationSource: admin
        ? "platform-admin"
        : grants.some((g) => g.source === "owner")
          ? "owner"
          : "access",
      canInvite: permissions.includes("access.invite"),
      canManage: permissions.includes("access.manage"),
      canCreatePreset: permissions.includes("preset.create"),
      canManagePresets: permissions.includes("preset.manage"),
      isPlatformAdmin: admin,
      hasMore: people.length > 100,
      people: people.slice(0, 100).map((person) => {
        const selections: Array<PermissionSelection> = selected.flatMap((s) =>
          s.access_id === person.id
            ? [{ kind: s.selection_kind, key: s.selection_key }]
            : []
        )
        const assignments = assigned.filter((a) => a.access_id === person.id)
        const presetIds = assignments.flatMap((a) =>
          a.preset_id ? [a.preset_id] : []
        )
        const builtinKeys = assignments.flatMap((a) =>
          a.builtin_key ? [a.builtin_key] : []
        )
        const assignedPresetIds = new Set(presetIds)
        const expanded = [
          ...selections,
          ...presetSelections.flatMap((s) =>
            assignedPresetIds.has(s.preset_id)
              ? [{ kind: s.selection_kind, key: s.selection_key }]
              : []
          ),
          ...builtinKeys.flatMap((key) =>
            builtinPresetSelections(key, person.resource_type)
          ),
        ]
        const invitation = attempts.find(
          (attempt) => attempt.access_id === person.id
        )
        return {
          id: person.id,
          userId: person.user_id,
          isOwner: person.user_id === owners[0]?.id,
          email: person.email,
          name: person.name,
          state: person.state,
          revision: Number(person.revision),
          scope: scopeFromRow(person),
          inherited:
            person.resource_type === "relay" && data.resourceType !== "relay",
          selections,
          presetIds,
          builtinKeys,
          permissions: expandPermissionSelections(
            deduplicatePermissionSelections(expanded),
            person.resource_type
          ),
          invitationId: invitation?.id ?? null,
          invitationExpiresAt: invitation?.expires_at.toISOString() ?? null,
          createdAt: person.created_at.toISOString(),
          updatedAt: person.updated_at.toISOString(),
        }
      }),
      presets: presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        revision: Number(preset.revision),
        assignmentCount: Number(preset.assignment_count),
        createdAt: preset.created_at.toISOString(),
        updatedAt: preset.updated_at.toISOString(),
        selections: presetSelections.flatMap((s) =>
          s.preset_id === preset.id
            ? [{ kind: s.selection_kind, key: s.selection_key }]
            : []
        ),
      })),
      defaults: builtinPermissionPresets.map((preset) => ({
        key: preset.key,
        name: preset.label,
        description: preset.description,
        selections: builtinPresetSelections(preset.key, data.resourceType),
      })),
    }
  })

export const getAccessResources = createServerFn({ method: "GET" })
  .validator(
    z.object({
      search: z.string().max(256).default(""),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(100).default(50),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser(),
      admin = user.role === "admin" || user.isDevelopmentBypass
    interface ResourceRow extends RowDataPacket {
      relay_id: string
      resource_type: ResourceScope["resourceType"]
      resource_id: string
      name: string
    }
    const allowedValues: Array<string | Array<string>> = []
    const clauses: Array<string> = []
    if (!admin) {
      const grants = await runAppEffect(
        "access.resourceDirectory",
        loadResourceGrantsEffect(user.id)
      )
      const byRelay = new Map<
        string,
        {
          relay: boolean
          instances: Set<string>
          databases: Set<string>
          allInstances: boolean
          allDatabases: boolean
        }
      >()
      for (const grant of grants) {
        const entry = byRelay.get(grant.relayId) ?? {
          relay: false,
          instances: new Set<string>(),
          databases: new Set<string>(),
          allInstances: false,
          allDatabases: false,
        }
        if (grant.resourceType === "relay") {
          entry.relay ||= grant.permissions.includes("relay.read")
          entry.allInstances ||= grant.permissions.includes("instance.read")
          entry.allDatabases ||= grant.permissions.includes("database.read")
        } else if (
          grant.resourceType === "instance" &&
          grant.permissions.includes("instance.read")
        )
          entry.instances.add(grant.resourceId)
        else if (
          grant.resourceType === "database" &&
          grant.permissions.includes("database.read")
        )
          entry.databases.add(grant.resourceId)
        byRelay.set(grant.relayId, entry)
      }
      for (const [relayId, entry] of byRelay) {
        if (entry.relay) {
          clauses.push("(relay_id = ? AND resource_type = 'relay')")
          allowedValues.push(relayId)
        }
        for (const [kind, all, ids] of [
          ["instance", entry.allInstances, entry.instances],
          ["database", entry.allDatabases, entry.databases],
        ] as const) {
          if (all) {
            clauses.push(`(relay_id = ? AND resource_type = '${kind}')`)
            allowedValues.push(relayId)
          } else if (ids.size) {
            clauses.push(
              `(relay_id = ? AND resource_type = '${kind}' AND resource_id IN (?))`
            )
            allowedValues.push(relayId, [...ids])
          }
        }
      }
    }
    const accessFilter = admin
      ? ""
      : ` AND (${clauses.join(" OR ") || "FALSE"})`
    const [resources] = await databasePool.query<Array<ResourceRow>>(
      `SELECT relay_id, resource_type, resource_id, name FROM (
    SELECT id AS relay_id, 'relay' AS resource_type, id AS resource_id, name, created_by AS owner_id FROM ${databaseTable("relay")} WHERE enabled = TRUE
    UNION ALL SELECT i.relay_id, 'instance', i.instance_id, COALESCE(i.display_name, i.source_name, i.instance_id), i.owner_id FROM ${databaseTable("instance")} i JOIN ${databaseTable("relay")} r ON r.id = i.relay_id AND r.enabled = TRUE
    UNION ALL SELECT d.relay_id, 'database', d.database_id, d.name, d.created_by FROM ${databaseTable("database")} d JOIN ${databaseTable("relay")} r ON r.id = d.relay_id AND r.enabled = TRUE
    ) resources WHERE (name LIKE ? OR resource_id LIKE ? OR relay_id LIKE ?)${accessFilter} ORDER BY name, resource_id LIMIT ? OFFSET ?`,
      [
        ...Array<string>(3).fill(
          `%${data.search.replace(/[\\%_]/gu, "\\$&")}%`
        ),
        ...allowedValues,
        data.limit + 1,
        data.offset,
      ]
    )
    return {
      resources: resources
        .slice(0, data.limit)
        .map((row) => ({ ...scopeFromRow(row), name: row.name })),
      hasMore: resources.length > data.limit,
    }
  })
