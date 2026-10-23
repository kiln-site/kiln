import { createServerFn } from "@tanstack/react-start"
import {
  relayIdSchema,
  relayPlatformActionInputSchema,
  relayPlatformLogsInputSchema,
  relayPlatformLogsSchema,
  relayPlatformStatusSchema,
  relayPlatformTargetSchema,
  relayPlatformTerminalClaimSchema,
  relayPlatformTerminalWriteSchema,
    relayPlatformV2Feature,
  type RelayPlatformStatus,
} from "@workspace/contracts"
import { z } from "zod"

import { recoverPromise } from "@/effect/promise"

// Kiln's own services: Hearth, its database, its cache, and the Traefik in
// front of it, as reported by the Relay on their Docker host. Platform
// administrators only; Hearth's logs can hold anything it printed.

export interface KilnPlatformHost {
  error: string | null
  relayId: string
  relayName: string
  status: RelayPlatformStatus | null
  /** Whether the Relay streams logs and opens shells (`relay-platform-v2`). */
  v2: boolean
}

export const getKilnPlatform = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ hosts: Array<KilnPlatformHost> }> => {
    const { platformRelays, requirePlatformAdministrator } =
      await import("@/server/platform-access.server")
    await requirePlatformAdministrator()
    const [relays, { relayConnectionFeatures, relayRpc }] = await Promise.all(
      [platformRelays(), import("@/lib/relay-connection")]
    )
    const hosts = await Promise.all(
      relays.map((relay) => {
        const v2 = relayConnectionFeatures(relay.id).has(relayPlatformV2Feature)
        return recoverPromise(
          async (): Promise<KilnPlatformHost> => ({
            error: null,
            relayId: relay.id,
            relayName: relay.name,
            status: relayPlatformStatusSchema.parse(
              await relayRpc(relay, "relay.platform.read", {}, 15_000)
            ),
            v2,
          }),
          (cause): KilnPlatformHost => ({
            error:
              cause instanceof Error ? cause.message : "The Relay didn't answer",
            relayId: relay.id,
            relayName: relay.name,
            status: null,
            v2,
          })
        )
      })
    )
    return { hosts }
  }
)

export const getKilnPlatformLogs = createServerFn({ method: "GET" })
  .validator(relayPlatformLogsInputSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { platformRelay, requirePlatformAdministrator } =
      await import("@/server/platform-access.server")
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
    const { platformRelay, requirePlatformAdministrator } =
      await import("@/server/platform-access.server")
    const user = await requirePlatformAdministrator()
    const [relay, { relayRpc }] = await Promise.all([
      platformRelay(relayId),
      import("@/lib/relay-connection"),
    ])
    return relayPlatformStatusSchema.parse(
      await relayRpc(relay, "relay.platform.action", input, 240_000, user.id)
    )
  })

const terminalSchema = z.object({
  relayId: relayIdSchema,
  role: relayPlatformTargetSchema,
})

export const writeKilnTerminal = createServerFn({ method: "POST" })
  .validator(relayPlatformTerminalWriteSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { databaseRpc, platformV2Relay, requirePlatformAdministrator } =
      await import("@/server/platform-access.server")
    const user = await requirePlatformAdministrator()
    const relay = await platformV2Relay(relayId)
    await databaseRpc(
      relay,
      "relay.platform.terminal.write",
      input,
      15_000,
      user.id
    )
    return { accepted: true }
  })

export const claimKilnTerminal = createServerFn({ method: "POST" })
  .validator(relayPlatformTerminalClaimSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { databaseRpc, platformV2Relay, requirePlatformAdministrator } =
      await import("@/server/platform-access.server")
    const user = await requirePlatformAdministrator()
    const relay = await platformV2Relay(relayId)
    return z
      .object({ seq: z.number().int().nonnegative() })
      .parse(
        await databaseRpc(
          relay,
          "relay.platform.terminal.claim",
          input,
          15_000,
          user.id
        )
      )
  })

export const restartKilnTerminal = createServerFn({ method: "POST" })
  .validator(terminalSchema)
  .handler(async ({ data: { relayId, role } }) => {
    const { databaseRpc, platformV2Relay, requirePlatformAdministrator } =
      await import("@/server/platform-access.server")
    const user = await requirePlatformAdministrator()
    const relay = await platformV2Relay(relayId)
    await databaseRpc(
      relay,
      "relay.platform.terminal.restart",
      { role },
      30_000,
      user.id
    )
    return { restarted: true }
  })
