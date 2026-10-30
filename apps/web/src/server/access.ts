import { createHash, randomBytes, randomUUID } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  permissionScopeTypeSchema,
  relayAuditRecordSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { Resend } from "resend"
import { z } from "zod"

import { AccessInvitationEmail } from "@/emails/access-invitation-email"
import { kilnEmailAttachments } from "@/emails/kiln-email"
import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import { forkPromise, promiseEffect } from "@/effect/promise"
import {
  isPlatformAdmin,
  isRelayCreator,
  listUserGrants,
  visibleRelaysForUser,
} from "@/lib/access-control"
import { auditInstanceCreatorId } from "@/lib/activity"
import { databasePool } from "@/lib/database"
import { databaseTable } from "@/lib/database-config"
import { emailDeliveryConfig, kilnPublicUrl } from "@/lib/environment"
import { invitationDestination } from "@/lib/invitation-auth"
import { grantHasPermission } from "@/lib/permissions"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { getCurrentUser, requireEligibleResourceUser } from "@/server/auth"
import {
  claimInstanceOwner,
  claimInstanceOwnerEffect,
  wakeDisplacedOwnerDelivery,
} from "@/lib/instance-registry"
import { resolveScopeAuthorization } from "@/lib/scope-authorization.server"
import {
  requireAppTransferable,
  transferAppOwnershipHandler,
} from "@/server/app-access"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { accessKey, exclusive, userKey } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
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
  requireTransferableEffect,
  transferResourceOwnershipEffect,
} from "@/lib/platform-access"

const tokenSchema = z.object({ token: z.string().min(32).max(256) })
const accessTypeSchema = z.enum(["platform_admin", "relay_creator", "scoped"])
const transferResourceOwnershipSchema = z.object({
  relayId: relayIdSchema,
  resourceType: permissionScopeTypeSchema,
  resourceId: z.string().min(1).max(64),
  userId: z.string().min(1).max(36),
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
])
const revokeInvitationSchema = z.object({ id: z.uuid() })
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
  accepted_at: number | null
  user_id: string | null
  declined_at: number | null
  cancelled_at: number | null
  email: string
  expires_at: number
  id: string
  database_id: string | null
  instance_id: string | null
  invited_by: string
  relay_id: string | null
  revoked_at: number | null
  role: string | null
}

interface PendingInvitationRow extends RowDataPacket {
  access_type: z.infer<typeof accessTypeSchema>
  created_at: number
  email: string
  expires_at: number
  id: string
  database_id: string | null
  instance_id: string | null
  relay_id: string | null
  role: string | null
}

interface PlatformRoleUserRow extends RowDataPacket, AccountPolicy {
  email: string
  id: string
  role: string | null
}

interface ExistingAccessUserRow extends RowDataPacket {
  email: string
  id: string
  name: string
  role: string | null
}

interface InstanceOwnerRow extends RowDataPacket {
  owner_id: string | null
  owner_provisional?: number
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
            AND i.cancelled_at IS NULL AND i.expires_at > ?`,
      [user.id, Date.now()]
    )
    return {
      // Whether any Relay this user can see is enabled, from Hearth's own
      // records, so the app frame never waits on the fleet to decide.
      relayConfigured: visibleRelaysForUser(user, relays, grants).length > 0,
      pendingScopes: pendingRows.map((row) => ({
        relayId: row.relay_id,
        resourceType: row.resource_type,
        resourceId: row.resource_id,
        invitationId: row.invitation_id,
      })),
      user,
      canManageAccess:
        platformAdmin ||
        isRelayCreator(user) ||
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
      isRelayCreator: isRelayCreator(user),
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

// Gives a person platform access, or invites them by email when they have
// no account to sign in with yet. Holds their address, and their account
// when they have one, so two changes to one person's access never
// interleave.
const grantPlatformAccess = operation<z.infer<typeof accessAssignmentSchema>>()(
  {
    name: "access.platform.grant",
    doing: "Changing this person's access",
    authorize: ({ input: data, user }) =>
      Effect.gen(function* () {
        const person = yield* signedIn(user)
        if (!isPlatformAdmin(person))
          return yield* Effect.fail(
            new Error(
              "Only a platform administrator can assign platform access"
            )
          )
        return yield* promiseEffect(async () => {
          const [existing] = await databasePool.query<
            Array<ExistingAccessUserRow>
          >(
            `SELECT auth_user.id, auth_user.name, auth_user.email, auth_user.role,
            (EXISTS (SELECT 1 FROM ${databaseTable("account")} WHERE userId = auth_user.id)
             OR EXISTS (SELECT 1 FROM ${databaseTable("passkey")} WHERE userId = auth_user.id)) AS has_credentials
             FROM ${databaseTable("user")} AS auth_user WHERE auth_user.email = ? LIMIT 1`,
            [data.email]
          )
          return { existing, person }
        })
      }),
    locks: ({ context: { existing }, input }) => [
      exclusive(`email:${input.email}`),
      ...(existing[0] ? [exclusive(userKey(existing[0].id))] : []),
    ],
    run: ({ context: { existing, person }, input }) =>
      promiseEffect(() => grantOrInvite(person, input, existing)),
    // Only an account's ID: an address stays out of the audit.
    audit: ({ context: { existing } }) =>
      existing[0] ? { id: existing[0].id, kind: "user" } : null,
  }
)

export const grantOrInviteAccess = createServerFn({ method: "POST" })
  .validator(accessAssignmentSchema)
  .handler(async ({ data }) =>
    runOperationPromise(grantPlatformAccess, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function grantOrInvite(
  user: AuthenticatedUser,
  data: z.infer<typeof accessAssignmentSchema>,
  existing: Array<ExistingAccessUserRow>
) {
  if (data.userId && existing[0]?.id !== data.userId)
    throw new Error("The account changed. Refresh the user list and try again.")
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
  const now = Date.now()
  const expiresAt = now + 7 * 24 * 60 * 60 * 1000
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
        VALUES (?, ?, ?, FALSE, 'user', 'enabled', ?, ?, ?)
        ON DUPLICATE KEY UPDATE id = id`,
            [
              randomUUID(),
              data.email,
              displayNameFromEmail(data.email),
              new Date(now),
              new Date(now),
              new Date(now),
            ]
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
            `UPDATE ${databaseTable("invitation")} SET revoked_at = ?, cancelled_at = ? WHERE user_id = ? AND access_type = ? AND accepted_at IS NULL AND revoked_at IS NULL`,
            [now, now, subject.id, data.accessType]
          )
          yield* tx.execute(
            `INSERT INTO ${databaseTable("invitation")} (id, token_hash, email, user_id, access_type, invited_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              id,
              hashToken(token),
              data.email,
              subject.id,
              data.accessType,
              user.id,
              expiresAt,
              now,
            ]
          )
          yield* tx.execute(
            `INSERT INTO ${databaseTable("auth_audit")} (user_id, event, metadata, created_at) VALUES (?, 'platform.invitation.created', ?, ?)`,
            [
              subject.id,
              JSON.stringify({
                actorId: user.id,
                invitationId: id,
                accessType: data.accessType,
              }),
              now,
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
          hearthUrl: publicUrl(),
          inviteUrl: inviteUrl.toString(),
          inviterName: user.name,
          resourceName: "Kiln",
          role:
            data.accessType === "platform_admin"
              ? "a platform administrator"
              : "a Relay creator",
          scope: "platform",
        }),
        attachments: kilnEmailAttachments,
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
    expiresAt: new Date(expiresAt).toISOString(),
    id,
    inviteUrl: inviteUrl.toString(),
    kind: "invitation",
  } satisfies InvitationAccessResult
}

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
          AND invitation.expires_at > ?
        ORDER BY invitation.created_at DESC, invitation.id DESC LIMIT ? OFFSET ?`,
      [Date.now(), data.limit + 1, data.offset]
    )
    return {
      hasMore: rows.length > data.limit,
      invitations: rows.slice(0, data.limit).map((row) => ({
        id: row.id,
        email: row.email,
        accessType: row.access_type,
        createdAt: new Date(row.created_at).toISOString(),
        expiresAt: new Date(row.expires_at).toISOString(),
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
    // A token proves receipt of the email. A bare ID does not, so only the
    // recipient or an administrator may resolve it to an address.
    if (!data.token) {
      const viewer = await getCurrentUser()
      if (
        !viewer ||
        (viewer.id !== invitation.user_id && !isPlatformAdmin(viewer))
      )
        return null
    }
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
      expiresAt: new Date(invitation.expires_at).toISOString(),
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

const acceptPlatformInvitation = operation<z.infer<typeof tokenSchema>>()({
  name: "access.platform.accept",
  doing: "Changing this person's access",
  authorize: ({ user }) => signedIn(user),
  locks: ({ context: person }) => [exclusive(userKey(person.id))],
  run: ({ context: person, input }) =>
    acceptPlatformInvitationEffect(person, hashToken(input.token)).pipe(
      Effect.as({ accepted: true })
    ),
  audit: ({ context: person }) => ({ id: person.id, kind: "user" }),
  publish: ({ context: person, exit }) => {
    if (exit._tag === "Success") publishAccessPolicyChange([person.id], true)
  },
})

export const acceptAccessInvitation = createServerFn({ method: "POST" })
  .validator(tokenSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const invitation = await readInvitation(data.token)
    // A resource's invitation is decided as its own operation.
    if (invitation?.access_type === "scoped") {
      const { decideResourceInvitation } =
        await import("@/server/resource-access")
      return decideResourceInvitation({
        data: { id: invitation.id, decision: "accept", force: false },
      })
    }
    return runOperationPromise(acceptPlatformInvitation, data, { user })
  })

const removeUserAccess = operation<
  z.infer<typeof removePlatformAccessSchema>
>()({
  name: "user.access.remove",
  doing: "Changing this person's access",
  authorize: ({ user }) =>
    Effect.gen(function* () {
      const person = yield* signedIn(user)
      if (!isPlatformAdmin(person)) {
        return yield* Effect.fail(
          new Error("Only a platform administrator can remove platform access")
        )
      }
      return person
    }),
  locks: ({ input }) => [exclusive(userKey(input.userId))],
  run: ({ context: person, input }) =>
    removePlatformAccessEffect({
      actingUserId: person.id,
      developmentBypass: person.isDevelopmentBypass,
      targetUserId: input.userId,
    }),
  audit: ({ input }) => ({ id: input.userId, kind: "user" }),
  publish: ({ exit, input }) => {
    if (exit._tag === "Success") publishAccessPolicyChange([input.userId], true)
  },
})

export const removePlatformAccess = createServerFn({ method: "POST" })
  .validator(removePlatformAccessSchema)
  .handler(async ({ data }) =>
    runOperationPromise(removeUserAccess, data, {
      user: await requireEligibleResourceUser(),
    })
  )

// Moving ownership changes who may do what on it.
const transferOwnership = operation<
  z.infer<typeof transferResourceOwnershipSchema>
>()({
  name: "access.ownership.transfer",
  doing: "Changing who may use this",
  authorize: ({ input, user }) =>
    Effect.gen(function* () {
      const person = yield* signedIn(user)
      const relay = yield* promiseEffect(() => requiredRelay(input.relayId))
      if (input.resourceType === "relay" && input.resourceId !== relay.id)
        return yield* Effect.fail(new Error("Resource not found"))
      // Authorize before resolving ownership: that lookup may call the
      // Relay and backfill owner_id, which no unprivileged caller should
      // trigger. Apps have no people of their own.
      if (input.resourceType !== "app") {
        const authorization = yield* promiseEffect(() =>
          resolveScopeAuthorization({ user: person, scope: input })
        )
        authorization.require("access.manage")
      }
      if (input.resourceType === "instance")
        yield* promiseEffect(() => instanceOwnerId(relay, input.resourceId))
      // Only an administrator or its owner may transfer it, as the transfer
      // checks again while it holds it.
      yield* requireTransferableEffect(person, input)
      return { person, relay }
    }),
  locks: ({ input }) => [
    exclusive(accessKey(input.resourceType, input.relayId, input.resourceId)),
  ],
  run: ({ context: { person, relay }, input }) =>
    Effect.gen(function* () {
      const result = yield* transferResourceOwnershipEffect(person, input)
      publishAccessPolicyChange(
        [result.previousOwnerId, input.userId].filter(
          (userId): userId is string => userId !== null
        ),
        false,
        relay.id
      )
      return { transferred: result.transferred }
    }),
  audit: ({ input }) => ({
    id: input.resourceId,
    kind: input.resourceType,
    relayId: input.relayId,
  }),
})

export const transferResourceOwnership = createServerFn({ method: "POST" })
  .validator(transferResourceOwnershipSchema)
  .handler(async ({ data }) =>
    runOperationPromise(transferOwnership, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const transferAppOwnershipSchema = z.object({
  appId: appIdSchema,
  email: z.email().transform((value) => value.trim().toLowerCase()),
  relayId: relayIdSchema,
})

const transferApp = operation<z.infer<typeof transferAppOwnershipSchema>>()({
  name: "access.app.transfer",
  doing: "Changing who owns this App",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(async () => {
          await requiredRelay(input.relayId)
          await requireAppTransferable(person, input)
        })
      )
    ),
  locks: ({ input }) => [
    exclusive(accessKey("app", input.relayId, input.appId)),
  ],
  run: ({ context: person, input }) =>
    promiseEffect(() => transferAppOwnershipHandler(person, input)).pipe(
      Effect.map((result) => {
        publishAccessPolicyChange(
          [result.previousOwnerId, result.userId].filter(
            (userId): userId is string => userId !== null
          ),
          false,
          input.relayId
        )
        return { transferred: true }
      })
    ),
  audit: ({ input }) => ({
    id: input.appId,
    kind: "app",
    relayId: input.relayId,
  }),
})

export const transferAppOwnership = createServerFn({ method: "POST" })
  .validator(transferAppOwnershipSchema)
  .handler(async ({ data }) =>
    runOperationPromise(transferApp, data, {
      user: await requireEligibleResourceUser(),
    })
  )

const revokePlatformInvitation = operation<
  z.infer<typeof revokeInvitationSchema>
>()({
  name: "access.platform.revoke",
  doing: "Changing this invitation",
  authorize: ({ user }) =>
    signedIn(user).pipe(
      Effect.filterOrFail(
        isPlatformAdmin,
        () =>
          new Error("Only a platform administrator can revoke this invitation")
      )
    ),
  locks: ({ input }) => [exclusive(`invitation:${input.id}`)],
  run: ({ context: person, input }) =>
    cancelPlatformInvitationEffect(person, input.id).pipe(
      Effect.as({ revoked: true })
    ),
  audit: ({ input }) => ({ id: input.id, kind: "invitation" }),
  publish: ({ exit }) => {
    if (exit._tag === "Success") publishAccessCollectionChange()
  },
})

export const revokeAccessInvitation = createServerFn({ method: "POST" })
  .validator(revokeInvitationSchema)
  .handler(async ({ data }) =>
    runOperationPromise(revokePlatformInvitation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

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
    invitation.expires_at > Date.now()
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
      : { kind: "platform-admins" },
    scope: relayId ? { relayId } : undefined,
    topics: ["access"],
    type: "hearth.invalidate",
  })
}

function publicUrl(): string {
  return kilnPublicUrl().origin
}

async function instanceOwnerId(
  relay: PersistedRelay,
  instanceId: string
): Promise<string | null> {
  const [persistedRows] = await databasePool.query<Array<InstanceOwnerRow>>(
    `SELECT owner_id, owner_provisional FROM ${databaseTable("instance")}
      WHERE relay_id = ? AND instance_id = ? LIMIT 1`,
    [relay.id, instanceId]
  )
  const persisted = persistedRows[0]
  // The Relay's owner stands in until its audit log names who made it.
  if (persisted?.owner_id && !persisted.owner_provisional)
    return persisted.owner_id

  const initialOwnerId = await instanceInitialOwnerId(relay, instanceId)
  if (!initialOwnerId) return persisted?.owner_id ?? null

  const now = Date.now()
  await runAppEffect(
    "access.instance.claimOwner",
    Effect.gen(function* () {
      const database = yield* Database
      const displaced = yield* database.transaction(
        "access.instance.claimOwner",
        (tx) =>
          claimInstanceOwnerEffect(
            tx,
            { instanceId, ownerId: initialOwnerId, relayId: relay.id },
            tx.execute(
              `INSERT INTO ${databaseTable("instance")}
                 (relay_id, instance_id, display_name, owner_id, created_at, updated_at)
               VALUES (?, ?, NULL, ?, ?, ?)
               ON DUPLICATE KEY UPDATE ${claimInstanceOwner},
                 updated_at = VALUES(updated_at)`,
              [relay.id, instanceId, initialOwnerId, now, now]
            )
          )
      )
      yield* wakeDisplacedOwnerDelivery(displaced)
    })
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
