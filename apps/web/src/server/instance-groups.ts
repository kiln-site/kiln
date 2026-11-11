import { createServerFn } from "@tanstack/react-start"
import {
  appNameSchema,
  brickSourceSchema,
  brickVariableValuesSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { requireEligibleResourceUser } from "@/server/auth"
import { createInstanceGroupFor } from "@/server/instance-group-create.server"

const createInstanceGroupInputSchema = z.strictObject({
  // The group Brick it is installed from, and its answers.
  brick: brickSourceSchema,
  idempotencyKey: z.uuid(),
  name: appNameSchema,
  relayId: relayIdSchema,
  variables: brickVariableValuesSchema.optional(),
})

// Installs a group Brick: what it makes, kept together as a group.
export const createInstanceGroup = createServerFn({ method: "POST" })
  .validator(createInstanceGroupInputSchema)
  .handler(async ({ data }) =>
    createInstanceGroupFor(await requireEligibleResourceUser(), data)
  )
