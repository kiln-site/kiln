import type { RowDataPacket } from "mysql2/promise"
import { appConfigSchema, appMountsSchema } from "@workspace/contracts"
import type { AppConfig, AppMount } from "@workspace/contracts"
import { Effect } from "effect"

import {
  loadAppConfigEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
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
  return authorizedAppFor(await requireEligibleResourceUser(), data, permission)
}

async function authorizedAppFor(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string },
  permission: AccessPermission
) {
  const relay = await requiredRelay(data.relayId)
  await requireRelayPermission({ permission, relayId: data.relayId, user })
  const app = await runAppEffect(
    "apps.config.internal",
    loadAppConfigEffect(data.relayId, data.appId)
  )
  if (!app) throw new Error("App not found")
  return { app, relay, user }
}

// What an edit may change. Databases change through the network, which also
// connects running containers, and limits through their own update, which
// applies them to running ones; everything else waits for the next
// deployment. Mounts have no default, so an edit that leaves them out keeps
// them.
export const appConfigPatchSchema = appConfigSchema
  .omit({ databaseIds: true, diskLimitBytes: true, serviceLimits: true })
  .partial()
  .extend({ mounts: appMountsSchema.optional() })

// The app's configuration. Its environment and the files it mounts carry
// secrets, so only people who can change the app see them.
export async function getAppConfigHandler(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string }
): Promise<{ config: AppConfig; environmentHidden: boolean }> {
  const { app } = await authorizedAppFor(user, data, "app.read")
  const canManage = await Effect.runPromise(
    Effect.tryPromise({
      try: () =>
        requireRelayPermission({
          permission: "app.manage",
          relayId: data.relayId,
          user,
        }),
      catch: (cause) => cause,
    }).pipe(
      Effect.as(true),
      Effect.orElseSucceed(() => false)
    )
  )
  return {
    config: canManage
      ? app.config
      : {
          ...app.config,
          environment: "",
          mounts: app.config.mounts.map((mount) =>
            mount.source.type === "file"
              ? { ...mount, source: { ...mount.source, content: "" } }
              : mount
          ),
        },
    environmentHidden: !canManage,
  }
}

/**
 * Saves only the fields an edit changes, into the config saved now. A path
 * on the node reaches anything on it, so mounting a new one takes the
 * permission that edits the host's files.
 */
export async function updateAppConfigHandler(
  user: AuthenticatedUser,
  data: { appId: string; config: unknown; relayId: string }
): Promise<AppConfig> {
  const patch = appConfigPatchSchema.parse(data.config)
  const { app } = await authorizedAppFor(user, data, "app.manage")
  if (patch.mounts && mountsNewHostPath(app.config, patch.mounts)) {
    await requireRelayPermission({
      permission: "relay.files.write",
      relayId: data.relayId,
      user,
    })
  }
  return runAppEffect(
    "apps.config.save",
    updateAppConfigEffect(data.relayId, data.appId, (current) =>
      appConfigSchema.parse({ ...current, ...patch })
    )
  )
}

// Whether mounts mount a path on the node the saved config doesn't, in the
// same place and as read-only.
function mountsNewHostPath(
  saved: AppConfig,
  mounts: ReadonlyArray<AppMount>
): boolean {
  const key = (mount: AppMount) =>
    mount.source.type === "host"
      ? JSON.stringify([
          mount.service,
          mount.target,
          mount.source.path,
          mount.readOnly,
        ])
      : null
  const existing = new Set(saved.mounts.map(key))
  return mounts.some((mount) => {
    const mounted = key(mount)
    return mounted !== null && !existing.has(mounted)
  })
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
