import { createHash, randomBytes, randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import { relayAuditRecordSchema, relayIdSchema } from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { Resend } from "resend"
import { z } from "zod"

import { AccessInvitationEmail } from "@/emails/access-invitation-email"
import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import { forkPromise } from "@/effect/promise"
import {
  deduplicateEffectiveInstanceGrants,
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
import {
  accessRoles,
  isAccessRole,
  grantHasPermission,
} from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  isAccountEnabled,
  isAccountVerified,
  type AccountPolicy,
} from "@/lib/account-policy"
import { displayNameFromEmail } from "@/lib/display-name"
import {
  acceptPlatformInvitationEffect,
  cancelPlatformInvitationEffect,
  assignPlatformAccessEffect,
  removePlatformAccessEffect,
  transferInstanceOwnershipEffect,
} from "@/lib/platform-access"

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
    userId: z.string().min(1).max(36).optional(),
    email: z.email().transform((value) => value.trim().toLowerCase()),
  }),
  z.object({
    accessType: z.literal("relay_creator"),
    userId: z.string().min(1).max(36).optional(),
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
  user_id: string | null
  declined_at: Date | null
  cancelled_at: Date | null
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

interface PlatformRoleUserRow extends RowDataPacket, AccountPolicy {
  email: string
  id: string
  role: string | null
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

export const getAccessCapabilities = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const platformAdmin = isPlatformAdmin(user)
    const relays = (await listPersistedRelays()).filter(
      (relay) => relay.enabled
    )
    const grants = platformAdmin ? [] : await listUserGrants(user.id)
    const enabledRelayIds = new Set(relays.map((relay) => relay.id))
    const [pendingRows] = await databasePool.query<
      Array<
        RowDataPacket & {
          relay_id: string
          resource_type: "relay" | "instance" | "database"
          resource_id: string
          invitation_id: string
        }
      >
    >(
      `SELECT g.relay_id, g.resource_type, g.resource_id, i.id AS invitation_id
           FROM ${databaseTable("access_grant")} g
           JOIN ${databaseTable("invitation")} i ON i.access_id = g.id AND i.user_id = g.user_id
           JOIN ${databaseTable("relay")} r ON r.id = g.relay_id AND r.enabled = TRUE
          WHERE g.user_id = ? AND g.state = 'pending' AND i.access_type = 'scoped'
            AND i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.declined_at IS NULL
            AND i.cancelled_at IS NULL AND i.expires_at > CURRENT_TIMESTAMP(3)`,
      [user.id]
    )
    return {
      pendingScopes: pendingRows.map((row) => ({
        relayId: row.relay_id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        invitationId: row.invitation_id,
      })),
      user,
      canManageAccess:
        platformAdmin ||
        grants.some(
          (grant) =>
            enabledRelayIds.has(grant.relayId) &&
            (
              [
                "access.manage",
                "access.read",
                "access.invite",
                "preset.read",
                "preset.create",
                "preset.manage",
              ] as const
            ).some((permission) => grantHasPermission(grant, permission))
        ),
      isPlatformAdmin: platformAdmin,
      canManageRelays:
        platformAdmin ||
        isRelayCreator(user) ||
        grants.some(
          (grant) =>
            enabledRelayIds.has(grant.relayId) &&
            grant.resourceType === "relay" &&
            grantHasPermission(grant, "relay.read")
        ),
      canUpdateHearth: platformAdmin,
      canUpdateRelays:
        platformAdmin ||
        grants.some(
          (grant) =>
            enabledRelayIds.has(grant.relayId) &&
            grant.resourceType === "relay" &&
            grantHasPermission(grant, "relay.update")
        ),
      grants,
    }
  }
)

export const getAccessOverview = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
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
            `SELECT id, user_id, email, access_type, relay_id, instance_id, database_id,
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
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "access.manage",
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
          grantHasPermission(grant, "access.manage") &&
          (grant.resourceType === "relay" ||
            (grant.resourceType === "instance" &&
              grant.resourceId === data.instanceId))
      )
    const canOpenAccessPage =
      platformAdmin ||
      userGrants.some(
        (grant) =>
          grant.resourceType === "relay" &&
          grantHasPermission(grant, "access.manage")
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
            AND grant_row.state = 'active'
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
  user: Awaited<ReturnType<typeof requireEligibleResourceUser>>,
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
          AND grant_row.state = 'active'
        ORDER BY auth_user.name ASC, grant_row.created_at ASC`,
      [relay.id]
    ),
    databasePool.query<Array<PendingInvitationRow>>(
      `SELECT id, user_id, email, access_type, relay_id, instance_id, database_id, role,
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
    if (data.accessType === "scoped")
      throw new Error(
        "Use resource access management to select permissions and send invitations"
      )
    const user = await requireEligibleResourceUser()
    if (!isPlatformAdmin(user))
      throw new Error(
        "Only a platform administrator can assign platform access"
      )
    const [existing] = await databasePool.query<Array<ExistingAccessUserRow>>(
      `SELECT auth_user.id, auth_user.name, auth_user.email, auth_user.role,
        (EXISTS (SELECT 1 FROM ${databaseTable("account")} WHERE userId = auth_user.id)
         OR EXISTS (SELECT 1 FROM ${databaseTable("passkey")} WHERE userId = auth_user.id)) AS has_credentials
         FROM ${databaseTable("user")} AS auth_user WHERE auth_user.email = ? LIMIT 1`,
      [data.email]
    )
    if (data.userId && existing[0]?.id !== data.userId)
      throw new Error(
        "The account changed. Refresh the user list and try again."
      )
    if (existing[0] && (data.userId || existing[0].has_credentials)) {
      await runAppEffect(
        "access.platform.assign",
        assignPlatformAccessEffect({
          accessType: data.accessType,
          actingUserId: user.id,
          developmentBypass: user.isDevelopmentBypass,
          userId: existing[0].id,
        })
      )
      publishAccessPolicyChange([existing[0].id], true)
      return {
        email: data.email,
        inviteUrl: null,
        kind: "granted",
        notificationStatus: "disabled" as AccessNotificationStatus,
      } satisfies DirectAccessResult
    }
    const id = randomUUID()
    const token = randomBytes(32).toString("base64url")
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000)
    await runAppEffect(
      "access.platform.invite",
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction("access.platform.invite", (tx) =>
          Effect.gen(function* () {
            const admins = yield* tx.queryRows<PlatformRoleUserRow>(
              `SELECT * FROM ${databaseTable("user")} WHERE role = 'admin' ORDER BY id FOR UPDATE`
            )
            if (
              !user.isDevelopmentBypass &&
              !admins.some(
                (admin) =>
                  admin.id === user.id &&
                  isAccountEnabled(admin) &&
                  isAccountVerified(admin)
              )
            )
              return yield* Effect.fail(
                new Error("Platform administrator required")
              )
            yield* tx.execute(
              `INSERT INTO ${databaseTable("user")} (id, email, name, emailVerified, role, status, statusChangedAt, createdAt, updatedAt)
          VALUES (?, ?, ?, FALSE, 'user', 'enabled', CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3))
          ON DUPLICATE KEY UPDATE id = id`,
              [randomUUID(), data.email, displayNameFromEmail(data.email)]
            )
            const subjects = yield* tx.queryRows<ExistingAccessUserRow>(
              `SELECT id FROM ${databaseTable("user")} WHERE email = ? FOR UPDATE`,
              [data.email]
            )
            const subject = subjects[0]
            if (!subject)
              return yield* Effect.fail(
                new Error("Could not create invited user")
              )
            yield* tx.execute(
              `UPDATE ${databaseTable("invitation")} SET revoked_at = CURRENT_TIMESTAMP(3), cancelled_at = CURRENT_TIMESTAMP(3) WHERE user_id = ? AND access_type = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
              [subject.id, data.accessType]
            )
            yield* tx.execute(
              `INSERT INTO ${databaseTable("invitation")} (id, token_hash, email, user_id, access_type, invited_by, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
              [
                id,
                hashToken(token),
                data.email,
                subject.id,
                data.accessType,
                user.id,
                expiresAt,
              ]
            )
            yield* tx.execute(
              `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata) VALUES (?, 'platform.invitation.created', ?)`,
              [
                subject.id,
                JSON.stringify({
                  actorId: user.id,
                  invitationId: id,
                  accessType: data.accessType,
                }),
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
      const response = await new Resend(delivery.apiKey).emails.send(
        {
          from: delivery.from,
          to: [data.email],
          subject: "You've been invited to Kiln",
          react: AccessInvitationEmail({
            inviteUrl: inviteUrl.toString(),
            inviterName: user.name,
            resourceName: "Kiln",
            role:
              data.accessType === "platform_admin"
                ? "platform administrator"
                : "Relay creator",
            scope: "platform",
          }),
        },
        { idempotencyKey: `access-invitation/${id}` }
      )
      await databasePool.execute(
        `UPDATE ${databaseTable("invitation")} SET delivery_status = ? WHERE id = ?`,
        [response.error ? "failed" : "sent", id]
      )
    }
    publishAccessCollectionChange()
    return {
      expiresAt: expiresAt.toISOString(),
      id,
      inviteUrl: inviteUrl.toString(),
      kind: "invitation",
    } satisfies InvitationAccessResult
  })

export const listPendingPlatformInvitations = createServerFn({ method: "GET" })
  .validator(
    z.object({
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(50).default(10),
    })
  )
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    if (!isPlatformAdmin(user))
      throw new Error("Platform administrator required")
    const [rows] = await databasePool.query<Array<PendingInvitationRow>>(
      `SELECT invitation.id, invitation.access_type, COALESCE(subject.email, invitation.email) AS email,
              invitation.created_at, invitation.expires_at
         FROM ${databaseTable("invitation")} AS invitation
         LEFT JOIN ${databaseTable("user")} AS subject ON subject.id = invitation.user_id
        WHERE invitation.relay_id IS NULL AND invitation.access_type <> 'scoped'
          AND invitation.accepted_at IS NULL AND invitation.revoked_at IS NULL
          AND invitation.declined_at IS NULL AND invitation.cancelled_at IS NULL
          AND invitation.expires_at > CURRENT_TIMESTAMP(3)
        ORDER BY invitation.created_at DESC, invitation.id DESC LIMIT ? OFFSET ?`,
      [data.limit + 1, data.offset]
    )
    return {
      hasMore: rows.length > data.limit,
      invitations: rows.slice(0, data.limit).map((row) => ({
        id: row.id,
        email: row.email,
        accessType: row.access_type,
        createdAt: row.created_at.toISOString(),
        expiresAt: row.expires_at.toISOString(),
      })),
    }
  })

export const getInvitationPreview = createServerFn({ method: "GET" })
  .validator(
    z
      .object({ token: z.string().min(32).optional(), id: z.uuid().optional() })
      .refine(
        (value) => Boolean(value.token || value.id),
        "An invitation is required"
      )
  )
  .handler(async ({ data }) => {
    const invitation = await readInvitation(data.token, data.id)
    if (!invitation || !isInvitationPending(invitation)) return null
    const [relay, userLookup] = await Promise.all([
      invitation.relay_id ? relayById(invitation.relay_id) : null,
      databasePool.query<Array<ExistingAccessUserRow>>(
        `SELECT auth_user.id, auth_user.email,
          (EXISTS (SELECT 1 FROM ${databaseTable("account")} WHERE userId = auth_user.id)
           OR EXISTS (SELECT 1 FROM ${databaseTable("passkey")} WHERE userId = auth_user.id)) AS has_credentials
          FROM ${databaseTable("user")} AS auth_user WHERE auth_user.id = ? LIMIT 1`,
        [invitation.user_id]
      ),
    ])
    return {
      accessType: invitation.access_type,
      accountExists: Boolean(userLookup[0][0]?.has_credentials),
      subjectId: invitation.user_id,
      email: userLookup[0][0]?.email ?? invitation.email,
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
    const user = await requireEligibleResourceUser()
    const invitation = await readInvitation(data.token)
    if (invitation?.access_type === "scoped") {
      const { decideResourceInvitation } =
        await import("@/server/resource-access")
      return decideResourceInvitation({
        data: { id: invitation.id, decision: "accept", force: false },
      })
    }
    await runAppEffect(
      "access.platform.accept",
      acceptPlatformInvitationEffect(user, hashToken(data.token))
    )
    publishAccessPolicyChange([user.id], true)
    return { accepted: true }
  })

export const removePlatformAccess = createServerFn({ method: "POST" })
  .validator(removePlatformAccessSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
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
  .handler(async (): Promise<{ updated: boolean }> => {
    throw new Error(
      "Use resource access management to edit selected permissions"
    )
  })
export const removeAccessGrant = createServerFn({ method: "POST" })
  .validator(relayResourceIdSchema)
  .handler(async (): Promise<{ removed: boolean }> => {
    throw new Error("Use resource access management to revoke access")
  })
export const removeInstanceAccessGrant = createServerFn({ method: "POST" })
  .validator(instanceGrantSchema)
  .handler(async (): Promise<{ removed: boolean }> => {
    throw new Error("Use resource access management to revoke access")
  })

export const transferInstanceOwnership = createServerFn({ method: "POST" })
  .validator(transferInstanceOwnershipSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await instanceOwnerId(relay, data.instanceId)

    const result = await runAppEffect(
      "access.instance.transferOwnership",
      transferInstanceOwnershipEffect(user, data)
    )
    publishAccessPolicyChange(
      [result.previousOwnerId, data.userId].filter(
        (userId): userId is string => userId !== null
      ),
      false,
      relay.id
    )
    return { transferred: result.transferred }
  })

export const revokeAccessInvitation = createServerFn({ method: "POST" })
  .validator(revokeInvitationSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    if (!data.relayId) {
      if (!isPlatformAdmin(user)) {
        throw new Error(
          "Only a platform administrator can revoke this invitation"
        )
      }
      await runAppEffect(
        "access.platform.cancel",
        cancelPlatformInvitationEffect(user, data.id)
      )
      publishAccessCollectionChange()
      return { revoked: true }
    }
    throw new Error("Use resource access management to cancel invitations")
  })

async function requiredRelay(relayId: string) {
  const relay = await relayById(relayId)
  if (!relay?.enabled) throw new Error("Relay not found")
  return relay
}

async function relayById(id: string) {
  return (await listPersistedRelays()).find((relay) => relay.id === id) ?? null
}

async function readInvitation(
  token?: string,
  id?: string
): Promise<InvitationRow | null> {
  const [rows] = await databasePool.query<Array<InvitationRow>>(
    `SELECT id, user_id, email, access_type, relay_id, instance_id, database_id, role, invited_by,
            expires_at, accepted_at, revoked_at, declined_at, cancelled_at
       FROM ${databaseTable("invitation")} WHERE ${token ? "token_hash" : "id"} = ? LIMIT 1`,
    [token ? hashToken(token) : (id ?? "")]
  )
  return rows[0] ?? null
}

function isInvitationPending(invitation: InvitationRow): boolean {
  return (
    !invitation.accepted_at &&
    !invitation.revoked_at &&
    !invitation.declined_at &&
    !invitation.cancelled_at &&
    invitation.expires_at.getTime() > Date.now()
  )
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex")
}

function publishAccessPolicyChange(
  userIds: Array<string>,
  reauthenticate = false,
  relayId?: string
): void {
  const uniqueUserIds = [...new Set(userIds)]
  if (uniqueUserIds.length === 0) return
  publishRealtimeChange({
    reauthenticate,
    type: "access.changed",
    userIds: uniqueUserIds,
  })
  publishAccessCollectionChange(relayId)
  forkPromise(async () => {
    const { wakePendingAuthorizationDelivery } =
      await import("@/lib/authorization-delivery")
    await wakePendingAuthorizationDelivery()
  })
}

function publishAccessCollectionChange(relayId?: string): void {
  publishRealtimeChange({
    audience: relayId
      ? { kind: "relays", relayIds: [relayId] }
      : { kind: "relay-managers" },
    scope: relayId ? { relayId } : undefined,
    topics: ["access"],
    type: "hearth.invalidate",
  })
}

function publicUrl(): string {
  return kilnPublicUrl().origin
}

async function canManageOwners(
  user: Awaited<ReturnType<typeof requireEligibleResourceUser>>,
  relayId: string
): Promise<boolean> {
  if (isPlatformAdmin(user)) return true
  return (await listUserGrants(user.id, relayId)).some(
    (grant) => grant.resourceType === "relay" && grant.role === "owner"
  )
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

  const initialOwnerId = await instanceInitialOwnerId(relay, instanceId)
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

async function instanceOwnerUser(
  ownerId: string,
  currentUser: Awaited<ReturnType<typeof requireEligibleResourceUser>>
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
