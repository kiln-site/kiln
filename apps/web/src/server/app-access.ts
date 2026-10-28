import type { RowDataPacket } from "mysql2/promise"
import { appConfigSchema, appMountsSchema } from "@workspace/contracts"
import type { AppConfig, AppMount } from "@workspace/contracts"
import { Effect } from "effect"

import {
  loadAppConfigEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
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
import { transferResourceOwnershipEffect } from "@/lib/platform-access"
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
  await requireRelayPermission({
    appId: data.appId,
    permission,
    relayId: data.relayId,
    user,
  })
  const app = await runAppEffect(
    "apps.config.internal",
    loadAppConfigEffect(data.relayId, data.appId)
  )
  if (!app) throw new Error("App not found")
  return { app, relay, user }
}

// What an edit may change. Limits change through their own update, which
// applies them to running containers, and databases through the network,
// which the Relay keeps; everything else waits for the next deployment.
// Mounts have no default, so an edit that leaves them out keeps them.
export const appConfigPatchSchema = appConfigSchema
  .omit({ serviceLimits: true })
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
          appId: data.appId,
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

/**
 * Whether grants allow a permission on one app, or on every app on a Relay
 * when `appId` is left out. A Relay grant covers its apps; owning an app
 * covers that app.
 */
export function hasAppPermission(
  user: AuthenticatedUser,
  grants: ReadonlyArray<AccessGrant>,
  app: { appId?: string; relayId: string },
  permission: AccessPermission
): boolean {
  if (isPlatformAdmin(user)) return true
  return grants.some(
    (grant) =>
      grant.relayId === app.relayId &&
      (grant.resourceType === "relay" ||
        (grant.resourceType === "app" && grant.resourceId === app.appId)) &&
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
  if (!hasAppPermission(user, grants, data, "app.read")) {
    throw new Error("App not found")
  }
  const [apps] = await databasePool.query<
    Array<RowDataPacket & { owner_id: string | null }>
  >(
    `SELECT owner_id FROM ${databaseTable("app")} WHERE relay_id = ? AND app_id = ?`,
    [data.relayId, data.appId]
  )
  const app = apps[0]
  if (!app) throw new Error("App not found")
  const [rows] = await databasePool.query<Array<AppOwnerRow>>(
    `SELECT id, name, email FROM ${databaseTable("user")} WHERE id = ?`,
    [app.owner_id]
  )
  return {
    canReadPeople: hasAppPermission(user, grants, data, "access.read"),
    row: rows[0],
  }
}

// The app's owner as its Info rail shows them, or null when their account is
// gone, and whether the viewer may hand the app to someone else.
export async function getAppOwnerHandler(
  user: AuthenticatedUser,
  data: { appId: string; relayId: string }
): Promise<{
  canTransfer: boolean
  owner: { email: string | null; name: string; userId: string } | null
}> {
  const { canReadPeople, row } = await readableAppOwner(user, data)
  return {
    canTransfer: isPlatformAdmin(user) || row?.id === user.id,
    owner: row
      ? {
          email: canReadPeople ? row.email : null,
          name: ownerDisplayName(row, canReadPeople),
          // For their picture.
          userId: row.id,
        }
      : null,
  }
}

/**
 * Makes the account with `email` the app's owner. The transfer admits only
 * an administrator or the app's owner, and a new owner with Relay access.
 * Asking by email keeps the Relay's people out of the owner's view.
 */
export async function transferAppOwnershipHandler(
  user: AuthenticatedUser,
  data: { appId: string; email: string; relayId: string }
): Promise<{ previousOwnerId: string | null; userId: string }> {
  // Only the owner or an administrator learns anything about the email; the
  // transfer checks this again while it holds the app.
  const [apps] = await databasePool.query<
    Array<RowDataPacket & { owner_id: string | null }>
  >(
    `SELECT owner_id FROM ${databaseTable("app")} WHERE relay_id = ? AND app_id = ?`,
    [data.relayId, data.appId]
  )
  if (!apps[0]) throw new Error("App not found")
  if (!isPlatformAdmin(user) && apps[0].owner_id !== user.id)
    throw new Error("Only the app owner can transfer ownership")
  const [rows] = await databasePool.query<
    Array<RowDataPacket & { id: string }>
  >(`SELECT id FROM ${databaseTable("user")} WHERE email = ? LIMIT 1`, [
    data.email,
  ])
  // One answer for a missing, ineligible or Relay-less account, so this
  // doesn't tell an app's owner who has an account here.
  const noRecipient = "No account with access to this Relay uses that email"
  const recipient = rows[0]
  if (!recipient) throw new Error(noRecipient)
  const result = await runAppEffect(
    "access.app.transferOwnership",
    transferResourceOwnershipEffect(user, {
      relayId: data.relayId,
      resourceType: "app",
      resourceId: data.appId,
      userId: recipient.id,
    }).pipe(
      Effect.mapError((error) =>
        /access to the Relay|enabled, verified account/u.test(error.message)
          ? new Error(noRecipient)
          : error
      )
    )
  )
  return { previousOwnerId: result.previousOwnerId, userId: recipient.id }
}
