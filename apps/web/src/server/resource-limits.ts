import { createServerFn } from "@tanstack/react-start"
import {
  appIdSchema,
  databaseIdSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { requireEligibleResourceUser } from "@/server/auth"
import { getResourceLimitsCapacityHandler } from "@/server/resource-limits.server"

const capacityInputSchema = z.strictObject({
  id: databaseIdSchema.or(appIdSchema),
  kind: z.enum(["app", "database", "server"]),
  relayId: relayIdSchema,
})

export const getResourceLimitsCapacity = createServerFn({ method: "GET" })
  .validator(capacityInputSchema)
  .handler(async ({ data }) =>
    getResourceLimitsCapacityHandler(await requireEligibleResourceUser(), data)
  )
