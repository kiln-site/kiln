import { z } from "zod"

import { INSTANCE_ID_PATTERN } from "./instance-id.js"

// Apps share some of servers' machinery by taking the place of a server ID
// with a key of their own.

// Files address an app's data directory as `app:<appId>` wherever they take
// a server's ID, so the file browser, its caches, and its Relay operations
// serve both.
const APP_FILE_ROOT_PREFIX = "app:"
// A volume an App owns or uses opens as a root of that App's own,
// `app:<appId>:volume:<volume ID>`, so it takes the App's file permissions.
// An App-owned volume's ID is `<appId>/<key>`, its `/` written `:`, since a
// root's ID travels in URLs; any other volume's is 40 hex characters.
const APP_VOLUME_FILE_ROOT =
  /^app:([a-f0-9]{12}):volume:([a-f0-9]{40}|[a-f0-9]{12}:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127})$/u
// A database's dumps travel as files under `database:<databaseId>`, a folder
// the Relay keeps for them, so they go through the same transfers.
const DATABASE_FILE_ROOT_PREFIX = "database:"
// A Relay's host files open as `relay:<relayId>`.
const RELAY_FILE_ROOT_PREFIX = "relay:"
const resourceIdPattern = INSTANCE_ID_PATTERN

// A Compose service's name; image and Dockerfile apps have one service, `app`.
export const appServiceNameSchema = z
  .string()
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62}$/u)

// A game server's files open under its bare ID.
export const fileRootIdSchema = z
  .string()
  .regex(
    /^(?:(?:app:|database:|relay:)?[a-f0-9]{12}|app:[a-f0-9]{12}:volume:(?:[a-f0-9]{40}|[a-f0-9]{12}:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}))$/u
  )
export function relayFileRootId(relayId: string): string {
  return `${RELAY_FILE_ROOT_PREFIX}${relayId}`
}
export function isRelayFileRoot(id: string): boolean {
  return (
    id.startsWith(RELAY_FILE_ROOT_PREFIX) &&
    resourceIdPattern.test(id.slice(RELAY_FILE_ROOT_PREFIX.length))
  )
}

export function appFileRootId(appId: string): string {
  return `${APP_FILE_ROOT_PREFIX}${appId}`
}

export function appVolumeFileRootId(appId: string, volumeId: string): string {
  return `${APP_FILE_ROOT_PREFIX}${appId}:volume:${volumeId.replace("/", ":")}`
}

/** The App and volume of a volume's root; null for any other root. */
export function appVolumeFromFileRoot(
  id: string
): { appId: string; volumeId: string } | null {
  const match = APP_VOLUME_FILE_ROOT.exec(id)
  if (!match) return null
  return { appId: match[1]!, volumeId: match[2]!.replace(":", "/") }
}

// The App a root belongs to: its folder's, or one of its volumes'.
export function appIdFromFileRoot(id: string): string | null {
  if (!id.startsWith(APP_FILE_ROOT_PREFIX)) return null
  const volume = appVolumeFromFileRoot(id)
  if (volume) return volume.appId
  const appId = id.slice(APP_FILE_ROOT_PREFIX.length)
  return resourceIdPattern.test(appId) ? appId : null
}

export function databaseFileRootId(databaseId: string): string {
  return `${DATABASE_FILE_ROOT_PREFIX}${databaseId}`
}

export function databaseIdFromFileRoot(id: string): string | null {
  if (!id.startsWith(DATABASE_FILE_ROOT_PREFIX)) return null
  const databaseId = id.slice(DATABASE_FILE_ROOT_PREFIX.length)
  return resourceIdPattern.test(databaseId) ? databaseId : null
}

// A server's files, as opposed to an app's, a database's dumps, or a Relay's
// host files.
export function isServerFileRoot(id: string): boolean {
  return (
    !appIdFromFileRoot(id) &&
    !databaseIdFromFileRoot(id) &&
    !isRelayFileRoot(id)
  )
}

// Tailscale network members are named by kind: a game server as
// `instance:<id>`, an App's service as `app:<appId>:<service>`, and a
// database as `database:<id>`.
const instanceMemberPattern = /^instance:([a-f0-9]{12})$/u
const databaseMemberPattern = /^database:([a-f0-9]{12})$/u
const appMemberPattern =
  /^app:([a-f0-9]{12}):([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})$/u

export const tailscaleMemberIdSchema = z
  .string()
  .regex(
    /^(?:instance:[a-f0-9]{12}|database:[a-f0-9]{12}|app:[a-f0-9]{12}:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})$/u
  )

export function instanceTailscaleMemberId(instanceId: string): string {
  return `instance:${instanceId}`
}

export function databaseTailscaleMemberId(databaseId: string): string {
  return `database:${databaseId}`
}

/** The database a member ID names, if it names one. */
export function databaseTailscaleMember(id: string): string | null {
  return databaseMemberPattern.exec(id)?.[1] ?? null
}

export function appTailscaleMemberId(appId: string, service: string): string {
  return `app:${appId}:${service}`
}

/** The game server a member ID names, if it names one. */
export function instanceTailscaleMember(id: string): string | null {
  return instanceMemberPattern.exec(id)?.[1] ?? null
}

export function appTailscaleMember(
  id: string
): { appId: string; service: string } | null {
  const match = appMemberPattern.exec(id)
  return match ? { appId: match[1]!, service: match[2]! } : null
}

/**
 * A member ID as bindings saved before typed IDs named it: a game server by
 * its bare ID. Only migrations read these.
 */
export function legacyTailscaleMemberId(id: string): string | null {
  if (resourceIdPattern.test(id)) return instanceTailscaleMemberId(id)
  return tailscaleMemberIdSchema.safeParse(id).success ? id : null
}
