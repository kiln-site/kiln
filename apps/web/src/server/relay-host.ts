import { createServerFn } from "@tanstack/react-start"
import {
  relayHostAccessSchema,
  relayHostTerminalClaimSchema,
  relayHostTerminalWriteSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { databaseRpc } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const targetSchema = z.object({ relayId: relayIdSchema })

export const getRelayHostAccess = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay } = await authorizedRelay(data.relayId, "relay.read")
    return relayHostAccessSchema.parse(
      await databaseRpc(relay, "relay.host.read", {}, 15_000)
    )
  })

export const writeRelayTerminal = createServerFn({ method: "POST" })
  .validator(relayHostTerminalWriteSchema.extend(targetSchema.shape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { relay, user } = await authorizedRelay(relayId, "relay.terminal")
    await databaseRpc(relay, "relay.terminal.write", input, 15_000, user.id)
    return { accepted: true }
  })

export const claimRelayTerminal = createServerFn({ method: "POST" })
  .validator(relayHostTerminalClaimSchema.extend(targetSchema.shape))
  .handler(async ({ data: { relayId, ...input } }) => {
    const { relay, user } = await authorizedRelay(relayId, "relay.terminal")
    return z
      .object({ seq: z.number().int().nonnegative() })
      .parse(
        await databaseRpc(relay, "relay.terminal.claim", input, 15_000, user.id)
      )
  })

export const restartRelayTerminal = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.terminal"
    )
    await databaseRpc(relay, "relay.terminal.restart", {}, 30_000, user.id)
    return { restarted: true }
  })
