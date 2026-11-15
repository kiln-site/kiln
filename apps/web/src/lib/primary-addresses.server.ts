import { relayCarriedPrimaryRoutesSchema } from "@workspace/contracts"

import { adoptPrimaryAddressEffect } from "@/effect/primary-addresses"
import { runAppEffect } from "@/effect/runtime"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayRpc } from "@/lib/relay-connection"
import { listPersistedRelays } from "@/lib/relay-registry"

/**
 * Takes the web routes a Relay marked primary before Hearth kept each
 * instance's primary address: an App's becomes its primary, unless one was
 * chosen since. A game server's primary is one of its join addresses, which
 * Hearth already had. Then the Relay forgets them. Run as the Relay
 * connects; one that fails is tried again on the next connect.
 */
export async function adoptCarriedPrimaryRoutes(relayId: string) {
  const relay = (await listPersistedRelays()).find(
    (candidate) => candidate.enabled && candidate.id === relayId
  )
  if (!relay) return
  const { routes } = relayCarriedPrimaryRoutesSchema.parse(
    await relayRpc(relay, "instance.network.primaries.carried", {}, 15_000)
  )
  if (routes.length === 0) return
  const adopted = new Set<string>()
  for (const route of routes) {
    if (route.resourceType !== "app") continue
    const took = await runAppEffect(
      "primaryAddresses.adopt",
      adoptPrimaryAddressEffect(
        { id: route.resourceId, type: "app" },
        { kind: "route", ref: route.id }
      )
    )
    if (took) adopted.add(route.resourceId)
  }
  await relayRpc(
    relay,
    "instance.network.primaries.forget",
    { routeIds: routes.map((route) => route.id) },
    15_000
  )
  for (const appId of adopted) {
    publishRealtimeChange({
      audience: { kind: "relays", relayIds: [relay.id] },
      scope: { instanceId: appId, relayId: relay.id },
      topics: ["instance-web-routes"],
      type: "hearth.invalidate",
    })
  }
}
