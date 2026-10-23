import { createServerFn } from "@tanstack/react-start"
import {
  relayIdSchema,
  relayPlatformActionInputSchema,
  relayPlatformLogsInputSchema,
  relayPlatformLogsSchema,
  relayPlatformStatusSchema,
  relayPlatformV1Feature,
  type RelayPlatformStatus,
} from "@workspace/contracts"
import { z } from "zod"

import { recoverPromise } from "@/effect/promise"
import { requireEligibleResourceUser } from "@/server/auth"

// Kiln's own services: Hearth, its database, and its cache, as reported by
// the Relay on their Docker host. Platform administrators only; Hearth's
// logs can hold anything it printed.

async function requirePlatformAdministrator() {
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
async function platformRelays() {
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

async function platformRelay(relayId: string) {
  const relay = (await platformRelays()).find(
    (candidate) => candidate.id === relayId
  )
  if (!relay) throw new Error("That Relay doesn't report Kiln's services")
  return relay
}

export interface KilnPlatformHost {
  error: string | null
  relayId: string
  relayName: string
  status: RelayPlatformStatus | null
}

export const getKilnPlatform = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ hosts: Array<KilnPlatformHost> }> => {
    await requirePlatformAdministrator()
    const [relays, { relayRpc }] = await Promise.all([
      platformRelays(),
      import("@/lib/relay-connection"),
    ])
    const hosts = await Promise.all(
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
    return { hosts }
  }
)

export const getKilnPlatformLogs = createServerFn({ method: "GET" })
  .validator(relayPlatformLogsInputSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data: { relayId, ...input } }) => {
    await requirePlatformAdministrator()
    const [relay, { relayRpc }] = await Promise.all([
      platformRelay(relayId),
      import("@/lib/relay-connection"),
    ])
    return relayPlatformLogsSchema.parse(
      await relayRpc(relay, "relay.platform.logs", input, 20_000)
    )
  })

export const runKilnPlatformAction = createServerFn({ method: "POST" })
  .validator(
    relayPlatformActionInputSchema.and(z.object({ relayId: relayIdSchema }))
  )
  .handler(async ({ data: { relayId, ...input } }) => {
    const user = await requirePlatformAdministrator()
    const [relay, { relayRpc }] = await Promise.all([
      platformRelay(relayId),
      import("@/lib/relay-connection"),
    ])
    return relayPlatformStatusSchema.parse(
      await relayRpc(relay, "relay.platform.action", input, 240_000, user.id)
    )
  })
