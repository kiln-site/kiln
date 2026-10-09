import { loadAppConfigEffect } from "@/effect/managed-apps"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
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
