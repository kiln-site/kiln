import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  databaseIdSchema,
  relayIdSchema,
  relayServerLimitsWriteSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import { resourceOperation } from "@/server/resource-operation.server"
import {
  getResourceLimitsCapacityHandler,
  saveInstanceLimits,
} from "@/server/resource-limits.server"

const capacityInputSchema = z.strictObject({
  id: databaseIdSchema.or(appIdSchema),
  kind: z.enum(["app", "database", "server"]),
  relayId: relayIdSchema,
})

const instanceLimitsInputSchema = relayServerLimitsWriteSchema.extend({
  relayId: relayIdSchema,
})

export const getResourceLimitsCapacity = createServerFn({ method: "GET" })
  .validator(capacityInputSchema)
  .handler(async ({ data }) =>
    getResourceLimitsCapacityHandler(await requireEligibleResourceUser(), data)
  )

// Saved at once; the game server takes them the next time it restarts.
const changeInstanceLimits = resourceOperation({
  kind: "server",
  id: (input: z.infer<typeof instanceLimitsInputSchema>) => input.instanceId,
  name: "server.limits.update",
  lock: { part: "config" },
  doing: "Changing this game server's limits",
  permission: () => "server.limits.write",
  run: saveInstanceLimits,
})

export const updateInstanceLimits = createServerFn({ method: "POST" })
  .validator(instanceLimitsInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeInstanceLimits, data, {
      user: await requireEligibleResourceUser(),
    })
  )
