import { createHash, randomBytes, randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import { relayAuditRecordSchema, relayIdSchema } from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { Resend } from "resend"
import { z } from "zod"

import { AccessGrantedEmail } from "@/emails/access-granted-email"
import { AccessInvitationEmail } from "@/emails/access-invitation-email"
import { Database, type DatabaseTransaction } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import {
  accessGrantRoleChangeError,
  deduplicateEffectiveInstanceGrants,
  grantExistingUserAccessEffect,
  hasRelayPermission,
  isCurrentInstanceOwnerGrant,
  isProtectedInstanceOwnerGrant,
  isPlatformAdmin,
  isRelayCreator,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import { auditInstanceCreatorId } from "@/lib/activity"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { emailDeliveryConfig, kilnPublicUrl } from "@/lib/environment"
import { invitationDestination } from "@/lib/invitation-auth"
import { accessRoles, isAccessRole, roleHasPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { requireAuthenticatedUser } from "@/server/auth"

const tokenSchema = z.object({ token: z.string().min(32).max(256) })
const accessTypeSchema = z.enum(["platform_admin", "relay_creator", "scoped"])
const relayResourceIdSchema = z.object({
  id: z.uuid(),
  relayId: relayIdSchema,
})
const instanceScopeSchema = z.object({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
  relayId: relayIdSchema,
})
const instanceGrantSchema = instanceScopeSchema.extend({ id: z.uuid() })
const transferInstanceOwnershipSchema = instanceScopeSchema.extend({
  userId: z.string().min(1).max(36),
})
const scopedAccessAssignmentSchema = z
  .object({
    accessType: z.literal("scoped"),
    databaseId: z
      .string()
      .regex(/^[a-f0-9]{40}$/u)
      .nullable(),
    email: z.email().transform((value) => value.trim().toLowerCase()),
    instanceId: z.string().min(1).max(64).nullable(),
    relayId: relayIdSchema,
    resourceName: z.string().trim().min(1).max(160),
    role: z.enum(accessRoles),
  })
  .refine((value) => !(value.databaseId && value.instanceId), {
    message: "Choose one invitation scope",
  })
const accessAssignmentSchema = z.discriminatedUnion("accessType", [
  z.object({
    accessType: z.literal("platform_admin"),
    email: z.email().transform((value) => value.trim().toLowerCase()),
  }),
  z.object({
    accessType: z.literal("relay_creator"),
    email: z.email().transform((value) => value.trim().toLowerCase()),
  }),
  scopedAccessAssignmentSchema,
])
const updateGrantSchema = relayResourceIdSchema.extend({
  role: z.enum(accessRoles),
})
const revokeInvitationSchema = z.object({
  id: z.uuid(),
  relayId: relayIdSchema.nullable(),
})
const removePlatformAccessSchema = z.object({
  userId: z.string().min(1).max(36),
})

type ScopedAccessAssignment = z.infer<typeof scopedAccessAssignmentSchema>
type AccessScope = "database" | "instance" | "relay"
type AccessNotificationScope = AccessScope | "platform"
type AccessNotificationStatus = "disabled" | "failed" | "sent"

interface DirectAccessResult {
  email: string
  inviteUrl: null
  kind: "granted"
  notificationStatus: AccessNotificationStatus
}

interface InvitationAccessResult {
  expiresAt: string
  id: string
  inviteUrl: string | null
  kind: "invitation"
}

interface InvitationRow extends RowDataPacket {
  access_type: z.infer<typeof accessTypeSchema>
  accepted_at: Date | null
  email: string
  expires_at: Date
  id: string
  database_id: string | null
  instance_id: string | null
  invited_by: string
  relay_id: string | null
  revoked_at: Date | null
  role: (typeof accessRoles)[number] | null
}

interface AccessOverviewRow extends RowDataPacket {
  created_at: Date
  email: string
  id: string
  name: string
  resource_id: string
  resource_type: "database" | "instance" | "relay"
  role: (typeof accessRoles)[number]
  user_id: string
}

interface PendingInvitationRow extends RowDataPacket {
  access_type: z.infer<typeof accessTypeSchema>
  created_at: Date
  email: string
  expires_at: Date
  id: string
  database_id: string | null
  instance_id: string | null
  relay_id: string | null
  role: (typeof accessRoles)[number] | null
}

interface PlatformAccessUserRow extends RowDataPacket {
  created_at: Date
  email: string
  id: string
  name: string
  role: "admin" | "relay_creator"
}

interface PlatformRoleUserRow extends RowDataPacket {
  email: string
  id: string
  role: string | null
}

interface DatabaseResourceRow extends RowDataPacket {
  database_id: string
}

interface InstanceGrantRow extends RowDataPacket {
  created_at: Date
  email: string
  id: string
  resource_type: "instance" | "relay"
  role: string
  user_id: string
}

interface InstanceUserRow extends RowDataPacket {
  email: string
  id: string
}

interface ExistingAccessUserRow extends RowDataPacket {
  email: string
  id: string
  name: string
  role: string | null
}

interface AccessUserRoleRow extends RowDataPacket {
  role: string | null
}

interface InstanceOwnerDirectoryRow extends RowDataPacket {
  created_at: Date
  email: string
  instance_id: string
  name: string
  user_id: string
}

interface InstanceOwnerRow extends RowDataPacket {
  owner_id: string | null
}

interface InstanceOwnerGrantRow extends RowDataPacket {
  user_id: string
}

interface InstanceScopedGrantRow extends InstanceOwnerGrantRow {
  role: string
}

interface AccessGrantMutationRow extends InstanceScopedGrantRow {
  resource_id: string
  resource_type: "database" | "instance" | "relay"
}

export const getAccessCapabilities = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    const platformAdmin = isPlatformAdmin(user)
    const relays = (await listPersistedRelays()).filter(
      (relay) => relay.enabled
    )
    const grants = platformAdmin ? [] : await listUserGrants(user.id)
    const enabledRelayIds = new Set(relays.map((relay) => relay.id))
    return {
      user,
      canManageAccess:
        platformAdmin ||
        grants.some(
          (grant) =>
            enabledRelayIds.has(grant.relayId) &&
            grant.resourceType === "relay" &&
            grant.resourceId === grant.relayId &&
            roleHasPermission(grant.role, "access.manage")
        ),
      isPlatformAdmin: platformAdmin,
      canManageRelays: platformAdmin || isRelayCreator(user),
      canUpdateHearth: platformAdmin,
      canUpdateRelays: platformAdmin || isRelayCreator(user),
      grants,
    }
  }
)

export const getAccessOverview = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    const platformAdmin = isPlatformAdmin(user)
    const relays = (await listPersistedRelays()).filter(
      (relay) => relay.enabled
    )
    const relayAccess = await Promise.all(
      relays.map(async (relay) => ({
        relay,
        manageable:
          platformAdmin ||
          (await hasRelayPermission({
            user,
            relayId: relay.id,
            permission: "access.manage",
          })),
      }))
    )
    const manageableRelays = relayAccess.flatMap((entry) =>
      entry.manageable ? [entry.relay] : []
    )
    if (!platformAdmin && manageableRelays.length === 0) {
      throw new Error("You do not have permission to manage Relay access")
    }
    const [sections, platformInvitations, platformUsers] = await Promise.all([
      Promise.all(
        manageableRelays.map((relay) => relayAccessOverview(user, relay))
      ),
      platformAdmin
        ? databasePool.query<Array<PendingInvitationRow>>(
            `SELECT id, email, access_type, relay_id, instance_id, database_id,
                    role, expires_at, created_at
               FROM ${databaseTable("invitation")}
              WHERE access_type <> 'scoped'
                AND accepted_at IS NULL
                AND revoked_at IS NULL
                AND expires_at > CURRENT_TIMESTAMP(3)
              ORDER BY created_at DESC`
          )
        : Promise.resolve([[]] as [Array<PendingInvitationRow>]),
      platformAdmin
        ? databasePool.query<Array<PlatformAccessUserRow>>(
            `SELECT id, name, email, role, createdAt AS created_at
               FROM ${databaseTable("user")}
              WHERE role IN ('admin', 'relay_creator')
              ORDER BY email ASC`
          )
        : Promise.resolve([[]] as [Array<PlatformAccessUserRow>]),
    ])
    return {
      grants: sections.flatMap((section) => section.grants),
      invitations: [
        ...platformInvitations[0].map((invitation) => ({
          accessType: invitation.access_type,
          createdAt: invitation.created_at.toISOString(),
          databaseId: null,
          email: invitation.email,
          expiresAt: invitation.expires_at.toISOString(),
          id: invitation.id,
          instanceId: null,
          relayId: null,
          relayName: "Kiln platform",
          role: null,
        })),
        ...sections.flatMap((section) => section.invitations),
      ],
      owners: sections.flatMap((section) => section.owners),
      ownerRelayIds: sections.flatMap((section) =>
        section.canManageOwners ? [section.relay.id] : []
      ),
      platformUsers: platformUsers[0].map((platformUser) => ({
        accessType:
          platformUser.role === "admin"
            ? ("platform_admin" as const)
            : ("relay_creator" as const),
        createdAt: platformUser.created_at.toISOString(),
        email: platformUser.email,
        id: platformUser.id,
        name: platformUser.name,
      })),
      relays: sections.map((section) => section.relay),
    }
  }
)

export const getInstanceUsers = createServerFn({ method: "GET" })
  .validator(instanceScopeSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.read",
      instanceId: data.instanceId,
    })

    const ownerId = await instanceOwnerId(relay, data.instanceId)
    const platformAdmin = isPlatformAdmin(user)
    const userGrants = platformAdmin
      ? []
      : await listUserGrants(user.id, relay.id)
    const canManage =
      platformAdmin ||
      ownerId === user.id ||
      userGrants.some(
        (grant) =>
          roleHasPermission(grant.role, "access.manage") &&
          (grant.resourceType === "relay" ||
            (grant.resourceType === "instance" &&
              grant.resourceId === data.instanceId))
      )
    const canOpenAccessPage =
      platformAdmin ||
      userGrants.some(
        (grant) =>
          grant.resourceType === "relay" &&
          roleHasPermission(grant.role, "access.manage")
      )

    const [grantRows, owner] = await Promise.all([
      databasePool.query<Array<InstanceGrantRow>>(
        `SELECT grant_row.id, grant_row.user_id, grant_row.role,
                grant_row.resource_type, grant_row.created_at, auth_user.email
           FROM ${databaseTable("access_grant")} AS grant_row
           JOIN ${databaseTable("user")} AS auth_user
             ON auth_user.id = grant_row.user_id
          WHERE grant_row.relay_id = ?
            AND (
              grant_row.resource_type = 'relay'
              OR (
                grant_row.resource_type = 'instance'
                AND grant_row.resource_id = ?
              )
            )
            AND COALESCE(auth_user.role, 'user') NOT IN ('admin', 'relay_creator')
          ORDER BY grant_row.created_at ASC`,
        [relay.id, data.instanceId]
      ),
      ownerId ? instanceOwnerUser(ownerId, user) : null,
    ])
    const grants = deduplicateEffectiveInstanceGrants(
      grantRows[0].flatMap((grant) =>
        isAccessRole(grant.role)
          ? [
              {
                createdAt: grant.created_at.toISOString(),
                email: grant.email,
                id: grant.id,
                resourceType: grant.resource_type,
                role: grant.role,
                userId: grant.user_id,
              },
            ]
          : []
      )
    )
    return {
      canManage,
      canOpenAccessPage,
      canTransferOwnership: platformAdmin || owner?.id === user.id,
      owner,
      users: grants.filter((grant) => grant.userId !== owner?.id),
    }
  })

async function relayAccessOverview(
  user: Awaited<ReturnType<typeof requireAuthenticatedUser>>,
  relay: PersistedRelay
) {
  const [grants, invitations, ownerRows, ownerAccess] = await Promise.all([
    databasePool.query<Array<AccessOverviewRow>>(
      `SELECT grant_row.id, grant_row.user_id, grant_row.resource_type,
              grant_row.resource_id, grant_row.role, grant_row.created_at,
              auth_user.name, auth_user.email
         FROM ${databaseTable("access_grant")} AS grant_row
         JOIN ${databaseTable("user")} AS auth_user ON auth_user.id = grant_row.user_id
        WHERE grant_row.relay_id = ?
          AND COALESCE(auth_user.role, 'user') NOT IN ('admin', 'relay_creator')
        ORDER BY auth_user.name ASC, grant_row.created_at ASC`,
      [relay.id]
    ),
    databasePool.query<Array<PendingInvitationRow>>(
      `SELECT id, email, access_type, relay_id, instance_id, database_id, role,
              expires_at, created_at
         FROM ${databaseTable("invitation")}
        WHERE relay_id = ?
          AND accepted_at IS NULL
          AND revoked_at IS NULL
          AND expires_at > CURRENT_TIMESTAMP(3)
        ORDER BY created_at DESC`,
      [relay.id]
    ),
    databasePool.query<Array<InstanceOwnerDirectoryRow>>(
      `SELECT instance_row.instance_id, instance_row.owner_id AS user_id,
              instance_row.created_at, auth_user.name, auth_user.email
         FROM ${databaseTable("instance")} AS instance_row
         JOIN ${databaseTable("user")} AS auth_user
           ON auth_user.id = instance_row.owner_id
        WHERE instance_row.relay_id = ?
          AND instance_row.owner_id IS NOT NULL
          AND COALESCE(auth_user.role, 'user') NOT IN ('admin', 'relay_creator')
        ORDER BY auth_user.name ASC, instance_row.created_at ASC`,
      [relay.id]
    ),
    canManageOwners(user, relay.id),
  ])
  const instanceIds = [
    ...new Set(
      grants[0].flatMap((grant) =>
        grant.resource_type === "instance" ? [grant.resource_id] : []
      )
    ),
  ]
  const instanceOwnerIds = new Map<string, string | null>()
  for (const owner of ownerRows[0]) {
    instanceOwnerIds.set(owner.instance_id, owner.user_id)
  }
  const unresolvedInstanceIds: Array<string> = []
  for (const instanceId of instanceIds) {
    if (!instanceOwnerIds.has(instanceId)) {
      unresolvedInstanceIds.push(instanceId)
    }
  }
  const ownerEntries = await Promise.all(
    unresolvedInstanceIds.map(async (instanceId) => ({
      instanceId,
      ownerId: await instanceOwnerId(relay, instanceId),
    }))
  )
  for (const entry of ownerEntries) {
    instanceOwnerIds.set(entry.instanceId, entry.ownerId)
  }

  return {
    canManageOwners: ownerAccess,
    grants: grants[0].map((grant) => {
      const ownerId =
        grant.resource_type === "instance"
          ? (instanceOwnerIds.get(grant.resource_id) ?? null)
          : null
      return {
        createdAt: grant.created_at.toISOString(),
        email: grant.email,
        id: grant.id,
        name: grant.name,
        instanceOwner:
          grant.resource_type === "instance" &&
          isCurrentInstanceOwnerGrant({
            grantUserId: grant.user_id,
            ownerId,
          }),
        protectedInstanceOwnerGrant:
          grant.resource_type === "instance" &&
          isProtectedInstanceOwnerGrant({
            grantRole: grant.role,
            grantUserId: grant.user_id,
            ownerId,
          }),
        relayId: relay.id,
        relayName: relay.name,
        resourceId: grant.resource_id,
        resourceType: grant.resource_type,
        role: grant.role,
        userId: grant.user_id,
      }
    }),
    invitations: invitations[0].map((invitation) => ({
      accessType: invitation.access_type,
      createdAt: invitation.created_at.toISOString(),
      email: invitation.email,
      expiresAt: invitation.expires_at.toISOString(),
      id: invitation.id,
      databaseId: invitation.database_id,
      instanceId: invitation.instance_id,
      relayId: relay.id,
      relayName: relay.name,
      role: invitation.role ?? "viewer",
    })),
    owners: ownerRows[0].map((owner) => ({
      createdAt: owner.created_at.toISOString(),
      email: owner.email,
      instanceId: owner.instance_id,
      name: owner.name,
      relayId: relay.id,
      relayName: relay.name,
      userId: owner.user_id,
    })),
    relay: { id: relay.id, name: relay.name },
  }
}

export const grantOrInviteAccess = createServerFn({ method: "POST" })
  .validator(accessAssignmentSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const scoped = data.accessType === "scoped"
    const relay = scoped ? await requiredRelay(data.relayId) : null
    if (scoped && relay) {
      await requireRelayPermission({
        user,
        relayId: relay.id,
        permission: "access.invite",
        databaseId: data.databaseId ?? undefined,
        instanceId: data.instanceId ?? undefined,
      })
    } else if (!isPlatformAdmin(user)) {
      throw new Error(
        "Only a platform administrator can assign platform access"
      )
    }
    const requestedOwnerAccess =
      scoped && data.role === "owner" && relay
        ? await canManageOwners(user, relay.id)
        : null
    if (requestedOwnerAccess === false) {
      throw new Error(
        "Only a Relay owner or platform admin can grant the owner role"
      )
    }

    const [existingUsers] = await databasePool.query<
      Array<ExistingAccessUserRow>
    >(
      `SELECT id, name, email, role
         FROM ${databaseTable("user")}
        WHERE email = ? LIMIT 1`,
      [data.email]
    )
    const existingUser = existingUsers[0]
    if (existingUser) {
      if (
        scoped &&
        (existingUser.role === "admin" || existingUser.role === "relay_creator")
      ) {
        throw new Error(
          "This user already has platform access. Change that access before assigning a scope."
        )
      }
      if (
        data.accessType === "relay_creator" &&
        existingUser.role === "admin"
      ) {
        throw new Error(
          "This user is already a platform administrator with broader access."
        )
      }
      if (data.accessType === "relay_creator") {
        const [existingGrants] = await databasePool.query<Array<RowDataPacket>>(
          `SELECT id FROM ${databaseTable("access_grant")}
            WHERE user_id = ? LIMIT 1`,
          [existingUser.id]
        )
        if (existingGrants.length > 0) {
          throw new Error(
            "Remove this user's scoped access before enabling bring-your-own-Relay access."
          )
        }
      }
      if (!scoped) {
        const platformRole =
          data.accessType === "platform_admin" ? "admin" : "relay_creator"
        await runAppEffect(
          "access.platform.assign",
          assignPlatformAccessEffect({
            accessType: data.accessType,
            actingUserId: user.id,
            developmentBypass: user.isDevelopmentBypass,
            userId: existingUser.id,
          })
        )
        publishAccessPolicyChange([existingUser.id], true)
        const notificationStatus = await runAppEffect(
          "access.notifyExistingPlatformUser",
          sendAccessGrantedNotification({
            email: existingUser.email,
            grantedBy: user.name,
            idempotencySeed: `${existingUser.id}:platform:${platformRole}`,
            resourceName: "Kiln",
            role:
              data.accessType === "platform_admin"
                ? "platform administrator"
                : "Relay creator",
            scope: "platform",
          }).pipe(
            Effect.match({
              onFailure: (cause): AccessNotificationStatus => {
                console.error(
                  `[Kiln access] Could not notify ${existingUser.email} about platform access`,
                  cause
                )
                return "failed"
              },
              onSuccess: (status): AccessNotificationStatus => status,
            })
          )
        )
        return {
          email: existingUser.email,
          inviteUrl: null,
          kind: "granted",
          notificationStatus,
        } satisfies DirectAccessResult
      }
      if (!relay) throw new Error("Relay not found")
      const scope = accessScope(data)
      if (scope.type === "instance") {
        await instanceOwnerId(relay, scope.id)
      }
      const ownerAccess =
        requestedOwnerAccess ?? (await canManageOwners(user, relay.id))
      await runAppEffect(
        "access.grantExistingUser",
        grantExistingUserAccessEffect({
          canManageOwners: ownerAccess,
          email: data.email,
          grantId: randomUUID(),
          grantedBy: user.id,
          relayId: relay.id,
          resourceId: scope.id,
          resourceType: scope.type,
          role: data.role,
          userId: existingUser.id,
        })
      )
      publishAccessPolicyChange([existingUser.id])
      const notificationStatus = await runAppEffect(
        "access.notifyExistingUser",
        sendAccessGrantedNotification({
          email: existingUser.email,
          grantedBy: user.name,
          idempotencySeed: `${existingUser.id}:${relay.id}:${scope.type}:${scope.id}:${data.role}`,
          resourceName: data.resourceName,
          role: data.role,
          scope: scope.type,
        }).pipe(
          Effect.match({
            onFailure: (cause): AccessNotificationStatus => {
              console.error(
                `[Kiln access] Could not notify ${existingUser.email} about access to ${data.resourceName}`,
                cause
              )
              return "failed"
            },
            onSuccess: (status): AccessNotificationStatus => status,
          })
        )
      )
      return {
        email: existingUser.email,
        inviteUrl: null,
        kind: "granted",
        notificationStatus,
      } satisfies DirectAccessResult
    }

    const token = randomBytes(32).toString("base64url")
    const id = randomUUID()
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await runAppEffect(
      "access.invitation.create",
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction(
          "access.invitation.create",
          (transaction) =>
            Effect.gen(function* () {
              if (!scoped && !user.isDevelopmentBypass) {
                const admins =
                  yield* transaction.queryRows<PlatformRoleUserRow>(
                    `SELECT id, email, role
                       FROM ${databaseTable("user")}
                      WHERE role = 'admin'
                      ORDER BY id
                      FOR UPDATE`
                  )
                if (!admins.some((admin) => admin.id === user.id)) {
                  return yield* Effect.fail(
                    new Error(
                      "Only a platform administrator can assign platform access"
                    )
                  )
                }
              }
              yield* transaction.execute(
                `UPDATE ${databaseTable("invitation")}
                    SET revoked_at = CURRENT_TIMESTAMP(3)
                  WHERE email = ? AND access_type = ?
                    AND ((relay_id IS NULL AND ? IS NULL) OR relay_id = ?)
                    AND ((instance_id IS NULL AND ? IS NULL) OR instance_id = ?)
                    AND ((database_id IS NULL AND ? IS NULL) OR database_id = ?)
                    AND accepted_at IS NULL AND revoked_at IS NULL`,
                [
                  data.email,
                  data.accessType,
                  scoped ? data.relayId : null,
                  scoped ? data.relayId : null,
                  scoped ? data.instanceId : null,
                  scoped ? data.instanceId : null,
                  scoped ? data.databaseId : null,
                  scoped ? data.databaseId : null,
                ]
              )
              yield* transaction.execute(
                `INSERT INTO ${databaseTable("invitation")}
                  (id, token_hash, email, access_type, relay_id, instance_id, database_id,
                   role, invited_by, expires_at)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                  id,
                  hashToken(token),
                  data.email,
                  data.accessType,
                  scoped ? data.relayId : null,
                  scoped ? data.instanceId : null,
                  scoped ? data.databaseId : null,
                  scoped ? data.role : null,
                  user.id,
                  expiresAt,
                ]
              )
            })
        )
      })
    )

    const inviteUrl = new URL("/invite", publicUrl())
    inviteUrl.searchParams.set("token", token)
    const delivery = emailDeliveryConfig()
    if (delivery) {
      const resend = new Resend(delivery.apiKey)
      const { error } = await resend.emails.send(
        {
          from: delivery.from,
          to: [data.email],
          subject: `You've been invited to ${scoped ? data.resourceName : "Kiln"}`,
          react: AccessInvitationEmail({
            inviteUrl: inviteUrl.toString(),
            inviterName: user.name,
            resourceName: scoped ? data.resourceName : "Kiln",
            role: scoped
              ? data.role
              : data.accessType === "platform_admin"
                ? "platform administrator"
                : "Relay creator",
            scope: scoped
              ? data.databaseId
                ? "database"
                : data.instanceId
                  ? "instance"
                  : "relay"
              : "platform",
          }),
        },
        { idempotencyKey: `access-invitation/${id}` }
      )
      if (error) {
        await databasePool.execute(
          `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
          [id]
        )
        throw new Error(error.message || "Could not send invitation email")
      }
    } else {
      console.info(`[Kiln access] Invitation for ${data.email}: ${inviteUrl}`)
    }
    return {
      expiresAt: expiresAt.toISOString(),
      id,
      inviteUrl: delivery ? null : inviteUrl.toString(),
      kind: "invitation",
    } satisfies InvitationAccessResult
  })

export const getInvitationPreview = createServerFn({ method: "GET" })
  .validator(tokenSchema)
  .handler(async ({ data }) => {
    const invitation = await readInvitation(data.token)
    if (!invitation || !isInvitationPending(invitation)) return null
    const [relay, userLookup] = await Promise.all([
      invitation.relay_id ? relayById(invitation.relay_id) : null,
      databasePool.query<Array<ExistingAccessUserRow>>(
        `SELECT id FROM ${databaseTable("user")} WHERE email = ? LIMIT 1`,
        [invitation.email]
      ),
    ])
    return {
      accessType: invitation.access_type,
      accountExists: userLookup[0].length > 0,
      email: invitation.email,
      databaseId: invitation.database_id,
      expiresAt: invitation.expires_at.toISOString(),
      instanceId: invitation.instance_id,
      relayName:
        invitation.access_type === "platform_admin"
          ? "Kiln platform"
          : invitation.access_type === "relay_creator"
            ? "Your Relays"
            : (relay?.name ?? "Kiln Relay"),
      returnPath: invitationDestination({
        accessType: invitation.access_type,
        databaseId: invitation.database_id,
        instanceId: invitation.instance_id,
      }),
      role: invitation.role,
    }
  })

export const acceptAccessInvitation = createServerFn({ method: "POST" })
  .validator(tokenSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    if (!user.emailVerified)
      throw new Error("Verify your email before accepting")
    const result = await runAppEffect(
      "access.invitation.accept",
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction("access.invitation.accept", (tx) =>
          Effect.gen(function* () {
            const rows = yield* tx.queryRows<InvitationRow>(
              `SELECT id, email, access_type, relay_id, instance_id, database_id,
                role, invited_by, expires_at, accepted_at, revoked_at
           FROM ${databaseTable("invitation")} WHERE token_hash = ? FOR UPDATE`,
              [hashToken(data.token)]
            )
            const invitation = rows.at(0)
            if (!invitation || !isInvitationPending(invitation)) {
              return yield* Effect.fail(
                new Error("This invitation is invalid or has expired")
              )
            }
            if (invitation.email.toLowerCase() !== user.email.toLowerCase()) {
              return yield* Effect.fail(
                new Error(
                  `Sign in as ${invitation.email} to accept this invitation`
                )
              )
            }
            const currentUserRows = yield* tx.queryRows<AccessUserRoleRow>(
              `SELECT role FROM ${databaseTable("user")}
                WHERE id = ? LIMIT 1 FOR UPDATE`,
              [user.id]
            )
            const currentRole = currentUserRows.at(0)?.role ?? "user"
            if (invitation.access_type !== "scoped") {
              if (
                invitation.access_type === "relay_creator" &&
                currentRole === "admin"
              ) {
                return yield* Effect.fail(
                  new Error(
                    "This account is already a platform administrator with broader access"
                  )
                )
              }
              if (invitation.access_type === "relay_creator") {
                const existingGrants = yield* tx.queryRows<RowDataPacket>(
                  `SELECT id FROM ${databaseTable("access_grant")}
                    WHERE user_id = ? LIMIT 1 FOR UPDATE`,
                  [user.id]
                )
                if (existingGrants.length > 0) {
                  return yield* Effect.fail(
                    new Error(
                      "Remove this account's scoped access before accepting bring-your-own-Relay access"
                    )
                  )
                }
              }
              const platformRole =
                invitation.access_type === "platform_admin"
                  ? "admin"
                  : "relay_creator"
              if (invitation.access_type === "platform_admin") {
                yield* deleteObsoleteScopedGrants(tx, user.id)
              }
              yield* tx.execute(
                `UPDATE ${databaseTable("user")} SET role = ? WHERE id = ?`,
                [platformRole, user.id]
              )
              if (currentRole !== platformRole) {
                yield* revokeUserCredentials(tx, user.id)
              }
              yield* tx.execute(
                `UPDATE ${databaseTable("invitation")} SET accepted_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
                [invitation.id]
              )
              return { accepted: true }
            }
            if (currentRole === "admin" || currentRole === "relay_creator") {
              return yield* Effect.fail(
                new Error(
                  "This account already has platform access and cannot accept scoped access"
                )
              )
            }
            if (!invitation.relay_id || !invitation.role) {
              return yield* Effect.fail(new Error("This invitation is invalid"))
            }
            if (invitation.database_id) {
              const databases = yield* tx.queryRows<DatabaseResourceRow>(
                `SELECT database_id FROM ${databaseTable("database")}
                  WHERE relay_id = ? AND database_id = ? FOR UPDATE`,
                [invitation.relay_id, invitation.database_id]
              )
              if (!databases.at(0)) {
                return yield* Effect.fail(
                  new Error("This database no longer exists")
                )
              }
            }
            const resourceType = invitation.database_id
              ? "database"
              : invitation.instance_id
                ? "instance"
                : "relay"
            const resourceId =
              invitation.database_id ??
              invitation.instance_id ??
              invitation.relay_id
            yield* tx.execute(
              `INSERT INTO ${databaseTable("access_grant")}
          (id, user_id, relay_id, resource_type, resource_id, role, granted_by)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE role = VALUES(role), granted_by = VALUES(granted_by)`,
              [
                randomUUID(),
                user.id,
                invitation.relay_id,
                resourceType,
                resourceId,
                invitation.role,
                invitation.invited_by,
              ]
            )
            yield* tx.execute(
              `UPDATE ${databaseTable("invitation")} SET accepted_at = CURRENT_TIMESTAMP(3) WHERE id = ?`,
              [invitation.id]
            )
            return { accepted: true }
          })
        )
      })
    )
    publishAccessPolicyChange([user.id], true)
    return result
  })

export const removePlatformAccess = createServerFn({ method: "POST" })
  .validator(removePlatformAccessSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    if (!isPlatformAdmin(user)) {
      throw new Error(
        "Only a platform administrator can remove platform access"
      )
    }
    const result = await runAppEffect(
      "access.platform.remove",
      removePlatformAccessEffect({
        actingUserId: user.id,
        developmentBypass: user.isDevelopmentBypass,
        targetUserId: data.userId,
      })
    )
    publishAccessPolicyChange([data.userId], true)
    return result
  })

export const updateAccessGrant = createServerFn({ method: "POST" })
  .validator(updateGrantSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "access.manage",
    })
    const initialGrant = await accessGrantMutationTarget(data.id, relay.id)
    if (!initialGrant) return { updated: true }
    await ensureInstanceGrantOwner(relay, initialGrant)
    const ownerAccess = await canManageOwners(user, relay.id)
    const result = await runAppEffect(
      "access.updateGrant",
      withLockedAccessGrant({
        grantId: data.id,
        initialGrant,
        missingResult: { updated: true },
        operation: "access.updateGrant",
        relayId: relay.id,
        use: ({ grant, ownerId, transaction }) =>
          Effect.gen(function* () {
            const roleChangeError = accessGrantRoleChangeError({
              canManageOwners: ownerAccess,
              currentRole: grant.role,
              nextRole: data.role,
              ownerId: grant.resource_type === "instance" ? ownerId : null,
              userId: grant.user_id,
            })
            if (roleChangeError) return yield* Effect.fail(roleChangeError)
            yield* transaction.execute(
              `UPDATE ${databaseTable("access_grant")} SET role = ? WHERE id = ? AND relay_id = ?`,
              [data.role, data.id, relay.id]
            )
            return { updated: true }
          }),
      })
    )
    publishAccessPolicyChange([initialGrant.user_id])
    return result
  })

export const removeAccessGrant = createServerFn({ method: "POST" })
  .validator(relayResourceIdSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "access.manage",
    })
    const initialGrant = await accessGrantMutationTarget(data.id, relay.id)
    if (!initialGrant) return { removed: true }
    await ensureInstanceGrantOwner(relay, initialGrant)
    const ownerAccess = await canManageOwners(user, relay.id)
    const result = await runAppEffect(
      "access.removeGrant",
      withLockedAccessGrant({
        grantId: data.id,
        initialGrant,
        missingResult: { removed: true },
        operation: "access.removeGrant",
        relayId: relay.id,
        use: ({ grant, ownerId, transaction }) =>
          Effect.gen(function* () {
            if (
              grant.resource_type === "instance" &&
              isProtectedInstanceOwnerGrant({
                grantRole: grant.role,
                grantUserId: grant.user_id,
                ownerId,
              })
            ) {
              return yield* Effect.fail(
                new Error(
                  "Transfer ownership before removing the server owner's access"
                )
              )
            }
            if (grant.role === "owner" && !ownerAccess) {
              return yield* Effect.fail(
                new Error(
                  "Only a Relay owner or platform admin can remove owner access"
                )
              )
            }
            yield* transaction.execute(
              `DELETE FROM ${databaseTable("access_grant")} WHERE id = ? AND relay_id = ?`,
              [data.id, relay.id]
            )
            return { removed: true }
          }),
      })
    )
    publishAccessPolicyChange([initialGrant.user_id])
    return result
  })

export const removeInstanceAccessGrant = createServerFn({ method: "POST" })
  .validator(instanceGrantSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    const [ownerId, initialGrant] = await Promise.all([
      instanceOwnerId(relay, data.instanceId),
      accessGrantMutationTarget(data.id, relay.id),
    ])
    if (!isPlatformAdmin(user) && ownerId !== user.id) {
      await requireRelayPermission({
        user,
        relayId: relay.id,
        permission: "access.manage",
        instanceId: data.instanceId,
      })
    }
    const result = await runAppEffect(
      "access.instance.removeGrant",
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction(
          "access.instance.removeGrant",
          (transaction) =>
            Effect.gen(function* () {
              const ownerRows = yield* transaction.queryRows<InstanceOwnerRow>(
                `SELECT owner_id FROM ${databaseTable("instance")}
                    WHERE relay_id = ? AND instance_id = ? LIMIT 1 FOR UPDATE`,
                [relay.id, data.instanceId]
              )
              const grantRows =
                yield* transaction.queryRows<InstanceScopedGrantRow>(
                  `SELECT user_id, role FROM ${databaseTable("access_grant")}
                    WHERE id = ? AND relay_id = ?
                      AND resource_type = 'instance' AND resource_id = ?
                    LIMIT 1 FOR UPDATE`,
                  [data.id, relay.id, data.instanceId]
                )
              const grant = grantRows.at(0)
              if (
                isProtectedInstanceOwnerGrant({
                  grantRole: grant?.role ?? null,
                  grantUserId: grant?.user_id ?? null,
                  ownerId: ownerRows.at(0)?.owner_id ?? null,
                })
              ) {
                return yield* Effect.fail(
                  new Error(
                    "Transfer ownership before removing the server owner's access"
                  )
                )
              }
              yield* transaction.execute(
                `DELETE FROM ${databaseTable("access_grant")}
                  WHERE id = ? AND relay_id = ?
                    AND resource_type = 'instance' AND resource_id = ?`,
                [data.id, relay.id, data.instanceId]
              )
              return { removed: true }
            })
        )
      })
    )
    if (initialGrant) publishAccessPolicyChange([initialGrant.user_id])
    return result
  })

export const transferInstanceOwnership = createServerFn({ method: "POST" })
  .validator(transferInstanceOwnershipSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    const previousOwnerId = await instanceOwnerId(relay, data.instanceId)
    const platformAdmin = isPlatformAdmin(user)

    const result = await runAppEffect(
      "access.instance.transferOwnership",
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction(
          "access.instance.transferOwnership",
          (transaction) =>
            Effect.gen(function* () {
              const ownerRows = yield* transaction.queryRows<InstanceOwnerRow>(
                `SELECT owner_id FROM ${databaseTable("instance")}
                    WHERE relay_id = ? AND instance_id = ? LIMIT 1 FOR UPDATE`,
                [relay.id, data.instanceId]
              )
              const ownerId = ownerRows.at(0)?.owner_id ?? null
              if (!platformAdmin && ownerId !== user.id) {
                return yield* Effect.fail(
                  new Error("Only the server owner can transfer ownership")
                )
              }
              if (ownerId === data.userId) {
                return yield* Effect.fail(
                  new Error("This user already owns the server")
                )
              }

              const targetGrants =
                yield* transaction.queryRows<InstanceOwnerGrantRow>(
                  `SELECT user_id FROM ${databaseTable("access_grant")}
                  WHERE user_id = ? AND relay_id = ?
                    AND resource_type = 'instance' AND resource_id = ?
                  LIMIT 1 FOR UPDATE`,
                  [data.userId, relay.id, data.instanceId]
                )
              if (!targetGrants.at(0)) {
                return yield* Effect.fail(
                  new Error(
                    "Give this user direct server access before transferring ownership"
                  )
                )
              }

              yield* transaction.execute(
                `INSERT INTO ${databaseTable("instance")}
                   (relay_id, instance_id, display_name, owner_id)
                 VALUES (?, ?, NULL, ?)
                 ON DUPLICATE KEY UPDATE owner_id = VALUES(owner_id)`,
                [relay.id, data.instanceId, data.userId]
              )
              yield* transaction.execute(
                `UPDATE ${databaseTable("access_grant")}
                    SET role = 'admin'
                  WHERE relay_id = ? AND resource_type = 'instance'
                    AND resource_id = ? AND role = 'owner' AND user_id <> ?`,
                [relay.id, data.instanceId, data.userId]
              )
              yield* transaction.execute(
                `UPDATE ${databaseTable("access_grant")}
                    SET role = 'owner', granted_by = ?
                  WHERE user_id = ? AND relay_id = ?
                    AND resource_type = 'instance' AND resource_id = ?`,
                [user.id, data.userId, relay.id, data.instanceId]
              )
              return { transferred: true }
            })
        )
      })
    )
    publishAccessPolicyChange(
      [previousOwnerId, data.userId].filter(
        (userId): userId is string => userId !== null
      )
    )
    return result
  })

export const revokeAccessInvitation = createServerFn({ method: "POST" })
  .validator(revokeInvitationSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    if (!data.relayId) {
      if (!isPlatformAdmin(user)) {
        throw new Error(
          "Only a platform administrator can revoke this invitation"
        )
      }
      await databasePool.execute(
        `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3)
          WHERE id = ? AND relay_id IS NULL AND accepted_at IS NULL`,
        [data.id]
      )
      return { revoked: true }
    }
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "access.manage",
    })
    const [invitationRows] = await databasePool.query<
      Array<{ role: string } & RowDataPacket>
    >(
      `SELECT role FROM ${databaseTable("invitation")} WHERE id = ? AND relay_id = ? LIMIT 1`,
      [data.id, relay.id]
    )
    if (
      invitationRows[0]?.role === "owner" &&
      !(await canManageOwners(user, relay.id))
    ) {
      throw new Error(
        "Only a Relay owner or platform admin can revoke an owner invitation"
      )
    }
    await databasePool.execute(
      `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3)
        WHERE id = ? AND relay_id = ? AND accepted_at IS NULL`,
      [data.id, relay.id]
    )
    return { revoked: true }
  })

export function assignPlatformAccessEffect(input: {
  accessType: "platform_admin" | "relay_creator"
  actingUserId: string
  developmentBypass: boolean
  userId: string
}) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction(
      "access.platform.assign",
      (transaction) =>
        Effect.gen(function* () {
          const admins = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT id, email, role
               FROM ${databaseTable("user")}
              WHERE role = 'admin'
              ORDER BY id
              FOR UPDATE`
          )
          if (
            !input.developmentBypass &&
            !admins.some((admin) => admin.id === input.actingUserId)
          ) {
            return yield* Effect.fail(
              new Error(
                "Only a platform administrator can assign platform access"
              )
            )
          }

          const users = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT id, email, role
               FROM ${databaseTable("user")}
              WHERE id = ? LIMIT 1 FOR UPDATE`,
            [input.userId]
          )
          const target = users.at(0)
          if (!target) return yield* Effect.fail(new Error("User not found"))
          if (input.accessType === "relay_creator" && target.role === "admin") {
            return yield* Effect.fail(
              new Error(
                "This user is already a platform administrator with broader access."
              )
            )
          }

          if (input.accessType === "relay_creator") {
            const existingGrants = yield* transaction.queryRows<RowDataPacket>(
              `SELECT id FROM ${databaseTable("access_grant")}
                  WHERE user_id = ? LIMIT 1 FOR UPDATE`,
              [input.userId]
            )
            if (existingGrants.length > 0) {
              return yield* Effect.fail(
                new Error(
                  "Remove this user's scoped access before enabling bring-your-own-Relay access."
                )
              )
            }
          } else {
            yield* deleteObsoleteScopedGrants(transaction, input.userId)
          }

          const platformRole =
            input.accessType === "platform_admin" ? "admin" : "relay_creator"
          yield* transaction.execute(
            `UPDATE ${databaseTable("user")} SET role = ? WHERE id = ?`,
            [platformRole, input.userId]
          )
          if (target.role !== platformRole) {
            yield* revokeUserCredentials(transaction, input.userId)
          }
        })
    )
  })
}

export function removePlatformAccessEffect(input: {
  actingUserId: string
  developmentBypass: boolean
  targetUserId: string
}) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction(
      "access.platform.remove",
      (transaction) =>
        Effect.gen(function* () {
          const admins = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT id, email, role
               FROM ${databaseTable("user")}
              WHERE role = 'admin'
              ORDER BY id
              FOR UPDATE`
          )
          if (
            !input.developmentBypass &&
            !admins.some((admin) => admin.id === input.actingUserId)
          ) {
            return yield* Effect.fail(
              new Error(
                "Only a platform administrator can remove platform access"
              )
            )
          }

          const users = yield* transaction.queryRows<PlatformRoleUserRow>(
            `SELECT id, email, role
               FROM ${databaseTable("user")}
              WHERE id = ? LIMIT 1 FOR UPDATE`,
            [input.targetUserId]
          )
          const target = users.at(0)
          if (
            !target ||
            (target.role !== "admin" && target.role !== "relay_creator")
          ) {
            return { removed: true }
          }
          if (target.role === "admin" && admins.length <= 1) {
            return yield* Effect.fail(
              new Error("At least one Platform Admin is required")
            )
          }

          yield* transaction.execute(
            `UPDATE ${databaseTable("user")} SET role = 'user' WHERE id = ?`,
            [target.id]
          )
          yield* transaction.execute(
            `UPDATE ${databaseTable("invitation")}
                SET revoked_at = CURRENT_TIMESTAMP(3)
              WHERE email = ?
                AND access_type <> 'scoped'
                AND accepted_at IS NULL
                AND revoked_at IS NULL`,
            [target.email]
          )
          yield* revokeUserCredentials(transaction, target.id)
          return { removed: true }
        })
    )
  })
}

function deleteObsoleteScopedGrants(
  transaction: DatabaseTransaction,
  userId: string
) {
  return transaction.execute(
    `DELETE grant_row
       FROM ${databaseTable("access_grant")} AS grant_row
       LEFT JOIN ${databaseTable("instance")} AS instance_row
         ON instance_row.relay_id = grant_row.relay_id
        AND instance_row.instance_id = grant_row.resource_id
        AND grant_row.resource_type = 'instance'
      WHERE grant_row.user_id = ?
        AND NOT (
          grant_row.resource_type = 'instance'
          AND (
            grant_row.role = 'owner'
            OR COALESCE(instance_row.owner_id = grant_row.user_id, FALSE)
          )
        )`,
    [userId]
  )
}

function revokeUserCredentials(
  transaction: DatabaseTransaction,
  userId: string
) {
  return Effect.gen(function* () {
    yield* transaction.execute(
      `DELETE FROM ${databaseTable("session")} WHERE userId = ?`,
      [userId]
    )
    yield* transaction.execute(
      `UPDATE ${databaseTable("cli_credential")}
          SET revoked_at = CURRENT_TIMESTAMP(3)
        WHERE user_id = ? AND revoked_at IS NULL`,
      [userId]
    )
  })
}

async function requiredRelay(relayId: string) {
  const relay = await relayById(relayId)
  if (!relay?.enabled) throw new Error("Relay not found")
  return relay
}

async function relayById(id: string) {
  return (await listPersistedRelays()).find((relay) => relay.id === id) ?? null
}

async function readInvitation(token: string): Promise<InvitationRow | null> {
  const [rows] = await databasePool.query<Array<InvitationRow>>(
    `SELECT id, email, access_type, relay_id, instance_id, database_id, role, invited_by,
            expires_at, accepted_at, revoked_at
       FROM ${databaseTable("invitation")} WHERE token_hash = ? LIMIT 1`,
    [hashToken(token)]
  )
  return rows[0] ?? null
}

function isInvitationPending(invitation: InvitationRow): boolean {
  return (
    !invitation.accepted_at &&
    !invitation.revoked_at &&
    invitation.expires_at.getTime() > Date.now()
  )
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function publishAccessPolicyChange(
  userIds: Array<string>,
  reauthenticate = false
): void {
  const uniqueUserIds = [...new Set(userIds)]
  if (uniqueUserIds.length === 0) return
  publishRealtimeChange({
    reauthenticate,
    type: "access.changed",
    userIds: uniqueUserIds,
  })
}

function publicUrl(): string {
  return kilnPublicUrl().origin
}

function accessScope(data: ScopedAccessAssignment): {
  id: string
  type: AccessScope
} {
  if (data.databaseId) {
    return { id: data.databaseId, type: "database" }
  }
  if (data.instanceId) {
    return { id: data.instanceId, type: "instance" }
  }
  return { id: data.relayId, type: "relay" }
}

function sendAccessGrantedNotification(input: {
  email: string
  grantedBy: string
  idempotencySeed: string
  resourceName: string
  role: string
  scope: AccessNotificationScope
}): Effect.Effect<Exclude<AccessNotificationStatus, "failed">, Error> {
  const delivery = emailDeliveryConfig()
  if (!delivery) {
    return Effect.sync(() => {
      console.info(
        `[Kiln access] ${input.email} received ${input.role} access to ${input.resourceName}`
      )
      return "disabled"
    })
  }

  return Effect.tryPromise({
    try: async (): Promise<"sent"> => {
      const resend = new Resend(delivery.apiKey)
      const notificationId = createHash("sha256")
        .update(input.idempotencySeed)
        .digest("hex")
        .slice(0, 24)
      const { error } = await resend.emails.send(
        {
          from: delivery.from,
          to: [input.email],
          subject: `${input.grantedBy} added you to ${input.resourceName} in Kiln`,
          react: AccessGrantedEmail({
            actionUrl: new URL("/", publicUrl()).toString(),
            grantedBy: input.grantedBy,
            resourceName: input.resourceName,
            role: input.role,
            scope: input.scope,
          }),
        },
        { idempotencyKey: `access-granted/${notificationId}` }
      )
      if (error) {
        throw new Error(error.message || "Could not send access notification")
      }
      return "sent"
    },
    catch: (cause) =>
      cause instanceof Error
        ? cause
        : new Error("Could not send access notification"),
  })
}

async function canManageOwners(
  user: Awaited<ReturnType<typeof requireAuthenticatedUser>>,
  relayId: string
): Promise<boolean> {
  if (isPlatformAdmin(user)) return true
  return (await listUserGrants(user.id, relayId)).some(
    (grant) => grant.resourceType === "relay" && grant.role === "owner"
  )
}

async function accessGrantMutationTarget(
  id: string,
  relayId: string
): Promise<AccessGrantMutationRow | null> {
  const [rows] = await databasePool.query<Array<AccessGrantMutationRow>>(
    `SELECT user_id, role, resource_type, resource_id
       FROM ${databaseTable("access_grant")}
      WHERE id = ? AND relay_id = ? LIMIT 1`,
    [id, relayId]
  )
  return rows[0] ?? null
}

async function ensureInstanceGrantOwner(
  relay: PersistedRelay,
  grant: AccessGrantMutationRow
): Promise<void> {
  if (grant.resource_type === "instance") {
    await instanceOwnerId(relay, grant.resource_id)
  }
}

function withLockedAccessGrant<TResult, TError, TRequirements>(input: {
  grantId: string
  initialGrant: AccessGrantMutationRow
  missingResult: TResult
  operation: string
  relayId: string
  use: (locked: {
    grant: AccessGrantMutationRow
    ownerId: string | null
    transaction: DatabaseTransaction
  }) => Effect.Effect<TResult, TError, TRequirements>
}) {
  return Effect.gen(function* () {
    const database = yield* Database
    return yield* database.transaction(input.operation, (transaction) =>
      Effect.gen(function* () {
        const ownerRows =
          input.initialGrant.resource_type === "instance"
            ? yield* transaction.queryRows<InstanceOwnerRow>(
                `SELECT owner_id FROM ${databaseTable("instance")}
                  WHERE relay_id = ? AND instance_id = ? LIMIT 1 FOR UPDATE`,
                [input.relayId, input.initialGrant.resource_id]
              )
            : []
        const grantRows = yield* transaction.queryRows<AccessGrantMutationRow>(
          `SELECT user_id, role, resource_type, resource_id
               FROM ${databaseTable("access_grant")}
              WHERE id = ? AND relay_id = ? LIMIT 1 FOR UPDATE`,
          [input.grantId, input.relayId]
        )
        const grant = grantRows.at(0)
        if (!grant) return input.missingResult
        if (
          grant.resource_type !== input.initialGrant.resource_type ||
          grant.resource_id !== input.initialGrant.resource_id
        ) {
          return yield* Effect.fail(
            new Error("Access grant changed while it was being modified")
          )
        }
        return yield* input.use({
          grant,
          ownerId: ownerRows.at(0)?.owner_id ?? null,
          transaction,
        })
      })
    )
  })
}

async function instanceOwnerId(
  relay: PersistedRelay,
  instanceId: string
): Promise<string | null> {
  const [persistedRows] = await databasePool.query<Array<InstanceOwnerRow>>(
    `SELECT owner_id FROM ${databaseTable("instance")}
      WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
    [relay.id, instanceId]
  )
  const persistedOwnerId = persistedRows[0]?.owner_id
  if (persistedOwnerId) return persistedOwnerId

  const initialOwnerId =
    (await instanceOwnerGrantId(relay.id, instanceId)) ??
    (await instanceInitialOwnerId(relay, instanceId))
  if (!initialOwnerId) return null

  await databasePool.execute(
    `INSERT INTO ${databaseTable("instance")}
       (relay_id, instance_id, display_name, owner_id)
     VALUES (?, ?, NULL, ?)
     ON DUPLICATE KEY UPDATE owner_id = COALESCE(owner_id, VALUES(owner_id))`,
    [relay.id, instanceId, initialOwnerId]
  )
  const [resolvedRows] = await databasePool.query<Array<InstanceOwnerRow>>(
    `SELECT owner_id FROM ${databaseTable("instance")}
      WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
    [relay.id, instanceId]
  )
  return resolvedRows[0]?.owner_id ?? initialOwnerId
}

async function instanceInitialOwnerId(
  relay: PersistedRelay,
  instanceId: string
): Promise<string | null> {
  return Effect.runPromise(
    Effect.tryPromise({
      try: async () => {
        const { relayRpc } = await import("@/lib/relay-connection")
        const records = z.array(relayAuditRecordSchema).parse(
          await relayRpc(relay, "relay.audit.list", {
            instanceIds: [instanceId],
            limit: 2_000,
          })
        )
        for (let index = records.length - 1; index >= 0; index -= 1) {
          const record = records[index]
          const creatorId = record
            ? auditInstanceCreatorId(record, instanceId)
            : null
          if (creatorId) return creatorId
        }
        return null
      },
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(null)))
  )
}

async function instanceOwnerGrantId(
  relayId: string,
  instanceId: string
): Promise<string | null> {
  const [rows] = await databasePool.query<Array<InstanceOwnerGrantRow>>(
    `SELECT user_id FROM ${databaseTable("access_grant")}
      WHERE relay_id = ? AND resource_type = 'instance'
        AND resource_id = ? AND role = 'owner'
      ORDER BY created_at ASC LIMIT 1`,
    [relayId, instanceId]
  )
  return rows[0]?.user_id ?? null
}

async function instanceOwnerUser(
  ownerId: string,
  currentUser: Awaited<ReturnType<typeof requireAuthenticatedUser>>
) {
  if (ownerId === currentUser.id) {
    return { email: currentUser.email, id: currentUser.id }
  }
  const [rows] = await databasePool.query<Array<InstanceUserRow>>(
    `SELECT id, email
       FROM ${databaseTable("user")} WHERE id = ? LIMIT 1`,
    [ownerId]
  )
  const owner = rows[0]
  return owner
    ? {
        email: owner.email,
        id: owner.id,
      }
    : {
        email: "Former user",
        id: ownerId,
      }
}
