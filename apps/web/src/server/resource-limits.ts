import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  databaseIdSchema,
  relayIdSchema,
  relayInstanceLimitsWriteSchema,
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

const instanceLimitsInputSchema = relayInstanceLimitsWriteSchema.extend({
  relayId: relayIdSchema,
})

export const getResourceLimitsCapacity = createServerFn({ method: "GET" })
  .validator(capacityInputSchema)
  .handler(async ({ data }) =>
    getResourceLimitsCapacityHandler(await requireEligibleResourceUser(), data)
  )

// Saved at once; the game server takes them the next time it restarts.
const changeInstanceLimits = resourceOperation({
  kind: "instance",
  id: (input: z.infer<typeof instanceLimitsInputSchema>) => input.instanceId,
  name: "instance.limits.update",
  lock: { part: "config" },
  doing: "Changing this game server's limits",
  permission: () => "instance.limits.write",
  run: saveInstanceLimits,
})

export const updateInstanceLimits = createServerFn({ method: "POST" })
  .validator(instanceLimitsInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(changeInstanceLimits, data, {
      user: await requireEligibleResourceUser(),
    })
  )
