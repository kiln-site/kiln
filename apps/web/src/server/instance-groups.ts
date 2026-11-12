import { createServerFn } from "@tanstack/react-start"
import {
  appNameSchema,
  brickSourceSchema,
  brickVariableValuesSchema,
  instanceIdSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

import { deleteConfirmationSchema } from "@/lib/delete-confirmation"
import { runOperationPromise } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  deleteInstanceGroup as deleteInstanceGroupOperation,
  getInstanceGroupHandler,
  listInstanceGroupsHandler,
} from "@/server/instance-group-access.server"
import { createInstanceGroupFor } from "@/server/instance-group-create.server"

const memberInputSchema = z.strictObject({
  instanceId: instanceIdSchema,
  kind: z.enum(["app", "database", "server"]),
  relayId: relayIdSchema,
})
const deleteInstanceGroupInputSchema = z.strictObject({
  ...deleteConfirmationSchema.shape,
  // The members to delete with it. The rest stay, in no group.
  delete: z.array(instanceIdSchema).max(64),
  groupId: instanceIdSchema,
})

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

// The group an instance is in, with the members this person may see.
export const getInstanceGroup = createServerFn({ method: "GET" })
  .validator(memberInputSchema)
  .handler(async ({ data }) =>
    getInstanceGroupHandler(await requireEligibleResourceUser(), data)
  )

// Every group, each with the members this person may see.
export const getInstanceGroups = createServerFn({ method: "GET" }).handler(
  async () => listInstanceGroupsHandler(await requireEligibleResourceUser())
)

// Forgets a group, deleting the members chosen. Asks the group's name and
// the account password, as deleting any one of them does.
export const deleteInstanceGroup = createServerFn({ method: "POST" })
  .validator(deleteInstanceGroupInputSchema)
  .handler(async ({ data }) =>
    runOperationPromise(deleteInstanceGroupOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )
