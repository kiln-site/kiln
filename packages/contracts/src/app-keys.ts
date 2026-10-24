import { z } from "zod"

// Apps share some of servers' machinery by taking the place of a server ID
// with a key of their own.

// Files address an app's data directory as `app:<appId>` wherever they take
// a server's ID, so the file browser, its caches, and its Relay operations
// serve both.
const APP_FILE_ROOT_PREFIX = "app:"
// A database's dumps travel as files under `database:<databaseId>`, a folder
// the Relay keeps for them, so they go through the same transfers.
const DATABASE_FILE_ROOT_PREFIX = "database:"
const resourceIdPattern = /^[a-f0-9]{40}$/u

// A Relay's host files use its fingerprint, scoped by the Relay connection.
export const fileRootIdSchema = z
  .string()
  .regex(/^(?:(?:app:)?[a-f0-9]{40}|[A-Za-z\d_-]{43})$/u)
export function isRelayFileRoot(id: string): boolean {
  return /^[A-Za-z\d_-]{43}$/u.test(id)
}

export function appFileRootId(appId: string): string {
  return `${APP_FILE_ROOT_PREFIX}${appId}`
}

export function appIdFromFileRoot(id: string): string | null {
  if (!id.startsWith(APP_FILE_ROOT_PREFIX)) return null
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

// An app's service joins a Tailscale network as `app:<appId>:<service>`
// wherever a server would be named by its ID.
const appMemberPattern =
  /^app:([a-f0-9]{40}):([a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})$/u

export const tailscaleMemberIdSchema = z
  .string()
  .regex(/^(?:[a-f0-9]{40}|app:[a-f0-9]{40}:[a-zA-Z0-9][a-zA-Z0-9_.-]{0,62})$/u)

export function appTailscaleMemberId(appId: string, service: string): string {
  return `app:${appId}:${service}`
}

export function appTailscaleMember(
  id: string
): { appId: string; service: string } | null {
  const match = appMemberPattern.exec(id)
  return match ? { appId: match[1]!, service: match[2]! } : null
}
