import { z } from "zod"

// Files address an app's data directory as `app:<appId>` wherever they take
// a server's ID, so the file browser, its caches, and its Relay operations
// serve both.
const APP_FILE_ROOT_PREFIX = "app:"
const resourceIdPattern = /^[a-f0-9]{40}$/u

export const fileRootIdSchema = z.string().regex(/^(?:app:)?[a-f0-9]{40}$/u)

export function appFileRootId(appId: string): string {
  return `${APP_FILE_ROOT_PREFIX}${appId}`
}

export function appIdFromFileRoot(id: string): string | null {
  if (!id.startsWith(APP_FILE_ROOT_PREFIX)) return null
  const appId = id.slice(APP_FILE_ROOT_PREFIX.length)
  return resourceIdPattern.test(appId) ? appId : null
}
