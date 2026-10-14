import { requireRelayPermission } from "@/lib/access-control"
import type { AccessPermission } from "@/lib/permissions"
import { requireEligibleResourceUser } from "@/server/auth"
import { requiredRelay } from "@/server/managed-database-access"

export async function authorizedRelay(
  relayId: string,
  permission: AccessPermission
) {
  const user = await requireEligibleResourceUser()
  await requireRelayPermission({ permission, relayId, user })
  const relay = await requiredRelay(relayId)
  return { relay, user }
}
