import {
  relayPlatformV1Feature,
  relayPlatformV2Feature,
} from "@workspace/contracts"

import { requireEligibleResourceUser } from "@/server/auth"

export { databaseRpc } from "@/server/managed-database-access"

// Who may reach Kiln's own services, and the Relays that report them.
// Platform administrators only; Hearth's logs can hold anything it printed.

export async function requirePlatformAdministrator() {
  const [user, { isPlatformAdmin }] = await Promise.all([
    requireEligibleResourceUser(),
    import("@/lib/access-control"),
  ])
  if (!isPlatformAdmin(user)) {
    throw new Error("Only a platform administrator can manage Kiln's services")
  }
  return user
}

// Relays that report Kiln's services, as of their last snapshot here.
export async function platformRelays() {
  const [{ listPersistedRelays }, connection] = await Promise.all([
    import("@/lib/relay-registry"),
    import("@/lib/relay-connection"),
  ])
  return (await listPersistedRelays()).filter(
    (relay) =>
      relay.enabled &&
      connection.relayConnectionPlatform(relay.id) !== null &&
      connection.relayConnectionFeatures(relay.id).has(relayPlatformV1Feature)
  )
}

export async function platformRelay(relayId: string) {
  const relay = (await platformRelays()).find(
    (candidate) => candidate.id === relayId
  )
  if (!relay) throw new Error("That Relay doesn't report Kiln's services")
  return relay
}

// A Relay that follows Kiln's containers' output and opens shells in them.
export async function platformV2Relay(relayId: string) {
  const [relay, { relayConnectionFeatures }] = await Promise.all([
    platformRelay(relayId),
    import("@/lib/relay-connection"),
  ])
  if (!relayConnectionFeatures(relay.id).has(relayPlatformV2Feature)) {
    throw new Error("Update this Relay to open Kiln's terminals.")
  }
  return relay
}

