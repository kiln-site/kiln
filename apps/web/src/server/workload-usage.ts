import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  databaseIdSchema,
  relayIdSchema,
  relayWorkloadUsageHistorySchema,
  relayWorkloadUsageSchema,
} from "@workspace/contracts"
import { z } from "zod"

const workloadUsageInputSchema = z.discriminatedUnion("kind", [
  z.object({
    history: relayWorkloadUsageHistorySchema,
    id: appIdSchema,
    kind: z.literal("app"),
    relayId: relayIdSchema,
  }),
  z.object({
    history: z.enum(["none", "resource"]).default("resource"),
    id: databaseIdSchema,
    kind: z.literal("database"),
    relayId: relayIdSchema,
  }),
])

// An App's or database's usage now and over the last minutes, for a
// browser that can't follow it on the Relay itself. It takes what reading
// the App or database does.
export const getWorkloadUsage = createServerFn({ method: "GET" })
  .validator(workloadUsageInputSchema)
  .handler(async ({ data }) => {
    const [
      { requireEligibleResourceUser },
      { requireRelayPermission },
      { databaseRpc, requiredRelay },
    ] = await Promise.all([
      import("@/server/auth"),
      import("@/lib/access-control"),
      import("@/server/managed-database-access"),
    ])
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    if (data.kind === "app") {
      await requireRelayPermission({
        appId: data.id,
        permission: "app.read",
        relayId: relay.id,
        user,
      })
      return relayWorkloadUsageSchema.parse(
        await databaseRpc(
          relay,
          "app.resources.read",
          { appId: data.id, history: data.history },
          10_000,
          user.id
        )
      )
    }
    await requireRelayPermission({
      databaseId: data.id,
      permission: "database.read",
      relayId: relay.id,
      user,
    })
    return relayWorkloadUsageSchema.parse(
      await databaseRpc(
        relay,
        "database.resources.read",
        { databaseId: data.id, history: data.history },
        10_000,
        user.id
      )
    )
  })
