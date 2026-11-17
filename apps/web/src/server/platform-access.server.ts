import { relayPlatformStatusSchema } from "@workspace/contracts"

import { recoverPromise } from "@/effect/promise"
import type { KilnPlatformHost } from "@/server/platform"

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
      relay.enabled && connection.relayConnectionPlatform(relay.id) !== null
  )
}

export async function platformRelay(relayId: string) {
  const relay = (await platformRelays()).find(
    (candidate) => candidate.id === relayId
  )
  if (!relay) throw new Error("That Relay doesn't report Kiln's services")
  return relay
}

/** Each Relay that reports Kiln's services, with what it reports of them. */
export async function kilnPlatformHosts(): Promise<Array<KilnPlatformHost>> {
  const [relays, { relayRpc }] = await Promise.all([
    platformRelays(),
    import("@/lib/relay-connection"),
  ])
  return Promise.all(
    relays.map((relay) =>
      recoverPromise(
        async (): Promise<KilnPlatformHost> => ({
          error: null,
          relayId: relay.id,
          relayName: relay.name,
          status: relayPlatformStatusSchema.parse(
            await relayRpc(relay, "relay.platform.read", {}, 15_000)
          ),
        }),
        (cause): KilnPlatformHost => ({
          error:
            cause instanceof Error ? cause.message : "The Relay didn't answer",
          relayId: relay.id,
          relayName: relay.name,
          status: null,
        })
      )
    )
  )
}
