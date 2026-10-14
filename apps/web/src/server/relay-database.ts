import { createServerFn } from "@tanstack/react-start"
import {
  databaseOverviewSchema,
  databaseQueryInputSchema,
  databaseQueryResultSchema,
  databaseRowsInputSchema,
  databaseRowsSchema,
  relayIdSchema,
  type DatabaseReadRequest,
} from "@workspace/contracts"
import { z } from "zod"

import { databaseRpc } from "@/server/managed-database-access"
import { authorizedRelay } from "@/server/relay-access"

const relayInputSchema = z.object({ relayId: relayIdSchema })

// The Relay opens its state read-only for every request.
async function readRelayState(relayId: string, request: DatabaseReadRequest) {
  const { relay, user } = await authorizedRelay(relayId, "relay.database.read")
  return databaseRpc(
    relay,
    "relay.database.read",
    { request },
    30_000,
    user.id
  )
}

export const getRelayStateDatabaseOverview = createServerFn({ method: "GET" })
  .validator(relayInputSchema)
  .handler(async ({ data }) =>
    databaseOverviewSchema.parse(
      await readRelayState(data.relayId, { action: "overview" })
    )
  )

export const getRelayStateDatabaseRows = createServerFn({ method: "POST" })
  .validator(relayInputSchema.extend({ request: databaseRowsInputSchema }))
  .handler(async ({ data }) =>
    databaseRowsSchema.parse(await readRelayState(data.relayId, data.request))
  )

export const runRelayStateDatabaseQuery = createServerFn({ method: "POST" })
  .validator(relayInputSchema.extend({ request: databaseQueryInputSchema }))
  .handler(async ({ data }) =>
    databaseQueryResultSchema.parse(
      await readRelayState(data.relayId, data.request)
    )
  )
