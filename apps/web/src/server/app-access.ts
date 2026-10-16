import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { loadAppConfigEffect } from "@/effect/managed-apps"
import { resolveMinecraftProfileEffect } from "@/effect/minecraft-profile"
import { ownerDisplayName } from "@/effect/relay-owners"
import { runAppEffect } from "@/effect/runtime"
import {
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTable } from "@/lib/database-config"
import { databasePool } from "@/lib/database"
import { grantHasPermission } from "@/lib/permissions"
import type { AccessPermission } from "@/lib/permissions"
import { requireEligibleResourceUser } from "@/server/auth"
import { requiredRelay } from "@/server/managed-database-access"

// Server-only helpers for app requests, kept apart from the server functions
// in apps.ts so their server imports stay out of the client bundle. App
// permissions are granted on a Relay, for every app on it.

export async function authorizedApp(
  data: { appId: string; relayId: string },
  permission: AccessPermission
) {
  const user = await requireEligibleResourceUser()
  const relay = await requiredRelay(data.relayId)
  await requireRelayPermission({ permission, relayId: data.relayId, user })
  const app = await runAppEffect(
    "apps.config.internal",
    loadAppConfigEffect(data.relayId, data.appId)
  )
  if (!app) throw new Error("App not found")
  return { app, relay, user }
}

export function hasAppPermission(
  user: AuthenticatedUser,
  grants: ReadonlyArray<AccessGrant>,
  relayId: string,
  permission: AccessPermission
): boolean {
  if (isPlatformAdmin(user)) return true
  return grants.some(
    (grant) =>
      grant.relayId === relayId &&
      grant.resourceType === "relay" &&
      grantHasPermission(grant, permission)
  )
}

interface AppOwnerRow extends RowDataPacket {
  email: string
  id: string
  name: string | null
}

// Who created an app, for those who can read the Relay's apps. As on the
// Access page, only those who can read the Relay's people see their email.
async function readableAppOwner(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string }
): Promise<{ canReadPeople: boolean; row: AppOwnerRow | undefined }> {
  const grants = isPlatformAdmin(user)
    ? []
    : await listUserGrants(user.id, data.relayId)
  if (!hasAppPermission(user, grants, data.relayId, "app.read")) {
    throw new Error("App not found")
  }
  const [apps] = await databasePool.query<
    Array<RowDataPacket & { created_by: string }>
  >(
    `SELECT created_by FROM ${databaseTable("app")} WHERE relay_id = ? AND app_id = ?`,
    [data.relayId, data.appId]
  )
  const app = apps[0]
  if (!app) throw new Error("App not found")
  const [rows] = await databasePool.query<Array<AppOwnerRow>>(
    `SELECT id, name, email FROM ${databaseTable("user")} WHERE id = ?`,
    [app.created_by]
  )
  return {
    canReadPeople: hasAppPermission(user, grants, data.relayId, "access.read"),
    row: rows[0],
  }
}

// The app's owner as its Info rail shows them, or null when their account is
// gone.
export async function getAppOwnerHandler(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string }
): Promise<{ email: string | null; name: string } | null> {
  const { canReadPeople, row } = await readableAppOwner(user, data)
  if (!row) return null
  return {
    email: canReadPeople ? row.email : null,
    name: ownerDisplayName(row, canReadPeople),
  }
}

// The owner's Minecraft profile ID, for their avatar. Only a stored display
// name reaches Mojang, never one derived from an email.
export async function getAppOwnerMinecraftProfileIdHandler(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string }
): Promise<string | null> {
  const { row } = await readableAppOwner(user, data)
  const name = row?.name?.trim()
  if (!name) return null
  const profile = await runAppEffect(
    "minecraft.appOwnerProfile.resolve",
    resolveMinecraftProfileEffect(name).pipe(
      Effect.catch(() => Effect.succeed(null))
    )
  )
  return profile?.id ?? null
}
