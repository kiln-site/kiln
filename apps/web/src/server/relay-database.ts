import { createServerFn } from "@tanstack/react-start"
import {
  databaseOverviewSchema,
  databaseRowsSchema,
  databaseQueryResultSchema,
  relayIdSchema,
  relayStateDatabaseReadSchema,
} from "@workspace/contracts"

import { databaseRpc } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

export const readRelayStateDatabase = createServerFn({ method: "POST" })
  .validator(relayStateDatabaseReadSchema.extend({ relayId: relayIdSchema }))
  .handler(async ({ data }) => {
    const { relay, user } = await authorizedRelay(
      data.relayId,
      "relay.database.read"
    )
    const result = await databaseRpc(
      relay,
      "relay.database.read",
      { request: data.request },
      30_000,
      user.id
    )
    switch (data.request.action) {
      case "overview":
        return databaseOverviewSchema.parse(result)
      case "rows":
        return databaseRowsSchema.parse(result)
      case "query":
        return databaseQueryResultSchema.parse(result)
    }
  })
