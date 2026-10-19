import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"
import type { PermissionSelection } from "@workspace/contracts"

import { resolveMinecraftProfileEffect } from "@/effect/minecraft-profile"
import { runAppEffect } from "@/effect/runtime"

import { isPlatformAdmin } from "@/lib/access-control"
import { isAccountEnabled } from "@/lib/account-policy"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import { databasePool } from "@/lib/database"
import { isMinecraftUsername } from "@/lib/minecraft-profile"
import { peopleFilter } from "@/server/resource-access.server"
import {
  effectiveScopePermissions,
  loadResourceGrantsEffect,
  type ResourceScope,
} from "@/lib/resource-permissions"

// The platform Users table and its Manage dialog. The server functions in
// ./users authenticate, then hand the user here.

export type ManagedUserState = "active" | "pending" | "disabled"

export interface ManagedUser {
  id: string
  name: string
  email: string
  role: string
  /** Pending until they first sign in; invited people already have a row. */
  state: ManagedUserState
  status: "enabled" | "disabled"
  statusChangedAt: string | null
  statusChangedBy: string | null
  statusReason: string | null
  statusExpiresAt: string | null
  emailVerified: boolean
  emailVerifiedAt: string | null
  manuallyVerifiedAt: string | null
  manuallyVerifiedBy: string | null
  legacyVerificationRecordedAt: string | null
  createdAt: string
  updatedAt: string
  hasCredential: boolean
  /** The platform role an unanswered invitation offers. */
  invitedRole: "platform_admin" | "relay_creator" | null
  /** Resources they own or were granted, and invitations they haven't answered. */
  /** Platform administrators reach everything, so theirs count every resource. */
  access: {
    relays: number
    instances: number
    /** Apps have no grants of their own, so only those they created. */
    apps: number
    databases: number
    /** Of those, how many they own; ownership must be transferred first. */
    owned: number
    pending: number
  }
}

interface UserRow extends RowDataPacket {
  id: string
  name: string
  email: string
  role: string | null
  status: "enabled" | "disabled"
  statusChangedAt: Date | null
  statusChangedBy: string | null
  statusReason: string | null
  statusExpiresAt: Date | null
  emailVerified: number
  emailVerifiedAt: Date | null
  manuallyVerifiedAt: Date | null
  manuallyVerifiedBy: string | null
  legacyVerificationRecordedAt: Date | null
  createdAt: Date
  updatedAt: Date
  hasCredential: number
  invitedRole: "platform_admin" | "relay_creator" | null
}

interface HoldingRow extends RowDataPacket {
  user_id: string
  resource_type: ResourceScope["resourceType"] | "app"
  relay_id: string
  resource_id: string
  /** Apps have no grants or owner; creating one is all that links a person to it. */
  state: "pending" | "active" | "created" | "owner"
  relay_enabled: number
}

function requirePlatformAdmin(actor: AuthenticatedUser) {
  if (!isPlatformAdmin(actor))
    throw new Error("Platform administrator required")
}

const openInvitation = (alias: string) =>
  `${alias}.accepted_at IS NULL AND ${alias}.revoked_at IS NULL AND ${alias}.declined_at IS NULL AND ${alias}.cancelled_at IS NULL AND ${alias}.expires_at > ?`
const hasCredential = `(EXISTS (SELECT 1 FROM ${databaseTable("account")} a WHERE a.userId = u.id)
  OR EXISTS (SELECT 1 FROM ${databaseTable("passkey")} p WHERE p.userId = u.id))`
// A row someone was invited with and has nothing left: no sign-in, no role,
// no open invitation, no access, and nothing they own. Removing a pending
// person leaves only this, so it isn't listed.
const holdsSomething = `(${hasCredential}
  OR COALESCE(u.role, 'user') IN ('admin', 'relay_creator')
  OR EXISTS (SELECT 1 FROM ${databaseTable("invitation")} i WHERE i.user_id = u.id AND ${openInvitation("i")})
  OR EXISTS (SELECT 1 FROM ${databaseTable("access_grant")} g WHERE g.user_id = u.id AND g.state <> 'revoked')
  OR EXISTS (SELECT 1 FROM ${databaseTable("instance")} s WHERE s.owner_id = u.id)
  OR EXISTS (SELECT 1 FROM ${databaseTable("database")} d WHERE d.created_by = u.id)
  OR EXISTS (SELECT 1 FROM ${databaseTable("relay")} r WHERE r.created_by = u.id))`

export async function listManagedUsersHandler(
  actor: AuthenticatedUser,
  data: { search?: string; offset: number; limit: number }
): Promise<{ items: Array<ManagedUser>; nextCursor: number | null }> {
  requirePlatformAdmin(actor)
  const now = Date.now()
  const clauses = [holdsSomething]
  const values: Array<string | number> = [now]
  if (data.search) {
    clauses.push("(u.email LIKE ? OR u.name LIKE ?)")
    const search = `%${data.search.replace(/[\\%_]/gu, "\\$&")}%`
    values.push(search, search)
  }
  const [rows] = await databasePool.query<Array<UserRow>>(
    `SELECT u.*, ${hasCredential} AS hasCredential,
       (SELECT i.access_type FROM ${databaseTable("invitation")} i
         WHERE i.user_id = u.id AND i.access_type <> 'scoped' AND ${openInvitation("i")}
         ORDER BY i.created_at DESC LIMIT 1) AS invitedRole
       FROM ${databaseTable("user")} u
      WHERE ${clauses.join(" AND ")}
      -- Kiln Admins, then Relay Creators, then everyone else, newest first:
      -- the order the Users table sorts by default, so pages arrive in it.
      ORDER BY FIELD(COALESCE(u.role, 'user'), 'admin', 'relay_creator') = 0,
               FIELD(COALESCE(u.role, 'user'), 'admin', 'relay_creator'),
               u.createdAt DESC, u.id LIMIT ? OFFSET ?`,
    [now, ...values, data.limit + 1, data.offset]
  )
  const page = rows.slice(0, data.limit)
  const [holdings, totals] = await Promise.all([
    userHoldings(page.map((row) => row.id)),
    page.some((row) => row.role === "admin") ? platformTotals() : undefined,
  ])
  return {
    items: page.map((row) => serializeUser(row, holdings.get(row.id), totals)),
    nextCursor: rows.length > data.limit ? data.offset + data.limit : null,
  }
}

/**
 * What each user holds on enabled Relays: grants not revoked and resources
 * they own, one entry per resource with the strongest hold.
 */
async function userHoldings(userIds: ReadonlyArray<string>) {
  const result = new Map<string, Array<HoldingRow>>()
  if (!userIds.length) return result
  // Ownership follows authority: a Relay's creator and a game server's
  // owner. Databases have no owner, so their creators aren't listed.
  // Disabled Relays are kept so ownership there still blocks removal.
  const [rows] = await databasePool.query<Array<HoldingRow>>(
    `SELECT g.user_id, g.resource_type, g.relay_id, g.resource_id, g.state, r.enabled AS relay_enabled
       FROM ${databaseTable("access_grant")} g
       JOIN ${databaseTable("relay")} r ON r.id = g.relay_id
      WHERE g.user_id IN (?) AND (g.state = 'active' OR (g.state = 'pending'
        -- An expired or declined invitation leaves nothing to accept.
        AND EXISTS (SELECT 1 FROM ${databaseTable("invitation")} i WHERE i.access_id = g.id AND ${openInvitation("i")})))
     UNION ALL
     SELECT s.owner_id, 'instance', s.relay_id, s.instance_id, 'owner', r.enabled
       FROM ${databaseTable("instance")} s
       JOIN ${databaseTable("relay")} r ON r.id = s.relay_id
      WHERE s.owner_id IN (?)
     UNION ALL
     SELECT a.created_by, 'app', a.relay_id, a.app_id, 'created', r.enabled
       FROM ${databaseTable("app")} a
       JOIN ${databaseTable("relay")} r ON r.id = a.relay_id
      WHERE a.created_by IN (?)
     UNION ALL
     SELECT r.created_by, 'relay', r.id, r.id, 'owner', r.enabled
       FROM ${databaseTable("relay")} r
      WHERE r.created_by IN (?)`,
    [userIds, Date.now(), userIds, userIds, userIds]
  )
  const strength = { pending: 0, created: 1, active: 2, owner: 3 } as const
  const strongest = new Map<string, HoldingRow>()
  for (const row of rows) {
    const key = `${row.user_id}|${row.resource_type}|${row.relay_id}|${row.resource_id}`
    const current = strongest.get(key)
    if (!current || strength[row.state] > strength[current.state])
      strongest.set(key, row)
  }
  for (const row of strongest.values())
    result.set(row.user_id, [...(result.get(row.user_id) ?? []), row])
  return result
}

type PlatformTotals = Record<
  "relays" | "instances" | "apps" | "databases",
  number
>

// Every resource on enabled Relays, which platform administrators can reach.
async function platformTotals(): Promise<PlatformTotals> {
  const [rows] = await databasePool.query<
    Array<RowDataPacket & PlatformTotals>
  >(
    `SELECT
       (SELECT COUNT(*) FROM ${databaseTable("relay")} WHERE enabled = TRUE) AS relays,
       (SELECT COUNT(*) FROM ${databaseTable("instance")} s JOIN ${databaseTable("relay")} r ON r.id = s.relay_id AND r.enabled = TRUE) AS instances,
       (SELECT COUNT(*) FROM ${databaseTable("app")} a JOIN ${databaseTable("relay")} r ON r.id = a.relay_id AND r.enabled = TRUE) AS apps,
       (SELECT COUNT(*) FROM ${databaseTable("database")} d JOIN ${databaseTable("relay")} r ON r.id = d.relay_id AND r.enabled = TRUE) AS \`databases\``
  )
  return {
    relays: Number(rows[0]?.relays ?? 0),
    instances: Number(rows[0]?.instances ?? 0),
    apps: Number(rows[0]?.apps ?? 0),
    databases: Number(rows[0]?.databases ?? 0),
  }
}

function serializeUser(
  row: UserRow,
  holdings: ReadonlyArray<HoldingRow> = [],
  totals?: PlatformTotals
): ManagedUser {
  const enabled = isAccountEnabled(row)
  // The counts show what's usable now, on enabled Relays.
  const live = holdings.filter((holding) => holding.relay_enabled)
  const held = live.filter((holding) => holding.state !== "pending")
  const count = (kind: HoldingRow["resource_type"]) =>
    held.filter((holding) => holding.resource_type === kind).length
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role ?? "user",
    state: !enabled ? "disabled" : row.hasCredential ? "active" : "pending",
    status: enabled ? "enabled" : "disabled",
    statusChangedAt: iso(row.statusChangedAt),
    statusChangedBy: row.statusChangedBy,
    statusReason: row.statusReason,
    statusExpiresAt: iso(row.statusExpiresAt),
    emailVerified: Boolean(row.emailVerified),
    emailVerifiedAt: iso(row.emailVerifiedAt),
    manuallyVerifiedAt: iso(row.manuallyVerifiedAt),
    manuallyVerifiedBy: row.manuallyVerifiedBy,
    legacyVerificationRecordedAt: iso(row.legacyVerificationRecordedAt),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    hasCredential: Boolean(row.hasCredential),
    invitedRole: row.invitedRole,
    access: {
      ...(row.role === "admin" && totals
        ? totals
        : {
            relays: count("relay"),
            instances: count("instance"),
            apps: count("app"),
            databases: count("database"),
          }),
      // Anywhere, disabled Relays included: removing someone leaves what
      // they own, which a re-enabled Relay would hand back.
      owned: holdings.filter((holding) => holding.state === "owner").length,
      pending: live.length - held.length,
    },
  }
}

function iso(value: Date | null): string | null {
  return value?.toISOString() ?? null
}

interface GrantRow extends RowDataPacket {
  id: string
  revision: number
  state: "pending" | "active"
  relay_id: string
  resource_type: ResourceScope["resourceType"]
  resource_id: string
  resource_name: string | null
  relay_name: string
  relay_enabled: number
}

export interface UserAccessGrant {
  id: string
  revision: number
  state: "pending" | "active"
  scope: ResourceScope
  resourceName: string
  relayName: string
  selections: Array<PermissionSelection>
  presetIds: Array<string>
  builtinKeys: Array<string>
  invitationId: string | null
  /**
   * Grants on disabled Relays come back so removal can revoke them; editors
   * show only enabled ones.
   */
  relayEnabled: boolean
}

export interface UserAccess {
  user: ManagedUser
  grants: Array<UserAccessGrant>
  /** Resources they own; owners hold every permission on them. */
  owned: Array<{
    scope: ResourceScope
    resourceName: string
    relayName: string
  }>
  /** Unanswered platform invitations, which removing them cancels. */
  platformInvitationIds: Array<string>
}

/** Everything a user holds, for the Manage dialog and removal. */
export async function getUserAccessHandler(
  actor: AuthenticatedUser,
  userId: string
): Promise<UserAccess> {
  requirePlatformAdmin(actor)
  const now = Date.now()
  const [users] = await databasePool.query<Array<UserRow>>(
    `SELECT u.*, ${hasCredential} AS hasCredential,
       (SELECT i.access_type FROM ${databaseTable("invitation")} i
         WHERE i.user_id = u.id AND i.access_type <> 'scoped' AND ${openInvitation("i")}
         ORDER BY i.created_at DESC LIMIT 1) AS invitedRole
       FROM ${databaseTable("user")} u WHERE u.id = ?`,
    [now, userId]
  )
  const row = users[0]
  if (!row) throw new Error("User not found")
  const resourceName = `COALESCE(
    CASE g.resource_type
      WHEN 'relay' THEN r.name
      WHEN 'instance' THEN (SELECT COALESCE(s.display_name, s.source_name, s.instance_id) FROM ${databaseTable("instance")} s WHERE s.relay_id = g.relay_id AND s.instance_id = g.resource_id)
      ELSE (SELECT d.name FROM ${databaseTable("database")} d WHERE d.relay_id = g.relay_id AND d.database_id = g.resource_id)
    END, g.resource_id)`
  const [grants] = await databasePool.query<Array<GrantRow>>(
    `SELECT g.id, g.revision, g.state, g.relay_id, g.resource_type, g.resource_id,
            ${resourceName} AS resource_name, r.name AS relay_name, r.enabled AS relay_enabled
       FROM ${databaseTable("access_grant")} g
       JOIN ${databaseTable("relay")} r ON r.id = g.relay_id
      WHERE g.user_id = ? AND g.state <> 'revoked'
      ORDER BY r.name, g.relay_id, FIELD(g.resource_type, 'relay', 'instance', 'database'), resource_name, g.id`,
    [userId]
  )
  const ids = grants.map((grant) => grant.id)
  const [selections] = ids.length
    ? await databasePool.query<
        Array<
          RowDataPacket & {
            access_id: string
            selection_kind: PermissionSelection["kind"]
            selection_key: string
          }
        >
      >(
        `SELECT access_id, selection_kind, selection_key FROM ${databaseTable("access_selection")} WHERE access_id IN (?) ORDER BY selection_key`,
        [ids]
      )
    : [[]]
  const [presets] = ids.length
    ? await databasePool.query<
        Array<
          RowDataPacket & {
            access_id: string
            preset_id: string | null
            builtin_key: string | null
          }
        >
      >(
        `SELECT access_id, preset_id, builtin_key FROM ${databaseTable("access_preset")} WHERE access_id IN (?)`,
        [ids]
      )
    : [[]]
  const [invitations] = await databasePool.query<
    Array<
      RowDataPacket & {
        id: string
        access_id: string | null
        access_type: string
      }
    >
  >(
    `SELECT i.id, i.access_id, i.access_type FROM ${databaseTable("invitation")} i
      WHERE i.user_id = ? AND ${openInvitation("i")} ORDER BY i.created_at DESC`,
    [userId, now]
  )
  const [owned] = await databasePool.query<
    Array<
      RowDataPacket & {
        relay_id: string
        resource_type: ResourceScope["resourceType"]
        resource_id: string
        name: string
        relay_name: string
      }
    >
  >(
    `SELECT r.id AS relay_id, 'relay' AS resource_type, r.id AS resource_id, r.name, r.name AS relay_name
       FROM ${databaseTable("relay")} r WHERE r.enabled = TRUE AND r.created_by = ?
     UNION ALL
     SELECT s.relay_id, 'instance', s.instance_id, COALESCE(s.display_name, s.source_name, s.instance_id), r.name
       FROM ${databaseTable("instance")} s JOIN ${databaseTable("relay")} r ON r.id = s.relay_id AND r.enabled = TRUE
      WHERE s.owner_id = ?`,
    [userId, userId]
  )
  const holdings = await userHoldings([userId])
  return {
    user: serializeUser(row, holdings.get(userId)),
    grants: grants.map((grant) => ({
      id: grant.id,
      revision: Number(grant.revision),
      state: grant.state,
      scope: {
        relayId: grant.relay_id,
        resourceType: grant.resource_type,
        resourceId: grant.resource_id,
      },
      resourceName: grant.resource_name ?? grant.resource_id,
      relayName: grant.relay_name,
      selections: selections.flatMap((selection) =>
        selection.access_id === grant.id
          ? [{ kind: selection.selection_kind, key: selection.selection_key }]
          : []
      ),
      presetIds: presets.flatMap((preset) =>
        preset.access_id === grant.id && preset.preset_id
          ? [preset.preset_id]
          : []
      ),
      builtinKeys: presets.flatMap((preset) =>
        preset.access_id === grant.id && preset.builtin_key
          ? [preset.builtin_key]
          : []
      ),
      invitationId:
        invitations.find((invitation) => invitation.access_id === grant.id)
          ?.id ?? null,
      relayEnabled: Boolean(grant.relay_enabled),
    })),
    owned: owned.map((resource) => ({
      scope: {
        relayId: resource.relay_id,
        resourceType: resource.resource_type,
        resourceId: resource.resource_id,
      },
      resourceName: resource.name,
      relayName: resource.relay_name,
    })),
    platformInvitationIds: invitations.flatMap((invitation) =>
      invitation.access_type === "scoped" ? [] : [invitation.id]
    ),
  }
}

/**
 * Minecraft profile IDs for users' heads, by user ID. Only names people chose
 * when signing up reach Mojang; a pending person's name comes from their email.
 */
export async function getUserMinecraftProfilesHandler(
  actor: AuthenticatedUser,
  userIds: ReadonlyArray<string>,
  /** Outside the platform view: a resource whose people the actor can read. */
  scope?: ResourceScope
): Promise<Record<string, string>> {
  const admin = isPlatformAdmin(actor)
  if (!admin) {
    if (!scope) throw new Error("Platform administrator required")
    const grants = await runAppEffect(
      "access.scope",
      loadResourceGrantsEffect(actor.id, scope.relayId, undefined, scope)
    )
    if (!effectiveScopePermissions(grants, scope).has("access.read"))
      throw new Error("Resource not found")
  }
  if (!userIds.length) return {}
  // Others only see heads for the people that resource lists: the same
  // filter as its Access page, inherited Relay access included.
  const people = admin ? null : peopleFilter(scope!)
  const [rows] = await databasePool.query<
    Array<RowDataPacket & { id: string; name: string }>
  >(
    `SELECT u.id, u.name FROM ${databaseTable("user")} u WHERE u.id IN (?) AND ${hasCredential}${
      people
        ? ` AND EXISTS (SELECT 1 FROM ${databaseTable("access_grant")} g WHERE g.user_id = u.id AND ${people.sql})`
        : ""
    }`,
    people ? [userIds, ...people.values] : [userIds]
  )
  const named = rows.filter((row) => isMinecraftUsername(row.name))
  const profiles = await runAppEffect(
    "minecraft.userProfiles.resolve",
    Effect.forEach(
      named,
      (row) =>
        resolveMinecraftProfileEffect(row.name).pipe(
          Effect.map((profile) => [row.id, profile?.id] as const),
          Effect.catch(() => Effect.succeed([row.id, undefined] as const))
        ),
      { concurrency: 4 }
    )
  )
  return Object.fromEntries(
    profiles.flatMap(([id, profileId]) => (profileId ? [[id, profileId]] : []))
  )
}
