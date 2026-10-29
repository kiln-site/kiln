import { relayIdSchema } from "@workspace/contracts"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { deleteConfirmationSchema } from "@/lib/delete-confirmation"

import {
  cancelResourceDeletionHandler,
  getResourceDeletionHandler,
  listVolumeDeletionsHandler,
  retryResourceDeletionHandler,
} from "@/server/resource-deletions.server"

// A game server's, database's, App's, or Kiln volume's deletion that's
// running, or that stopped for someone to try again or keep it.
const targetSchema = z.strictObject({
  kind: z.enum(["instance", "database", "app", "volume"]),
  relayId: relayIdSchema,
  // Each has a 40-hex ID; an App's own volumes go with it.
  resourceId: z.string().regex(/^[a-f0-9]{40}$/u),
})

export const getResourceDeletion = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(({ data }) => getResourceDeletionHandler(data))

export const listVolumeDeletions = createServerFn({ method: "GET" })
  .validator(z.strictObject({ relayId: relayIdSchema }))
  .handler(({ data }) => listVolumeDeletionsHandler(data))

export const retryResourceDeletion = createServerFn({ method: "POST" })
  .validator(
    targetSchema.extend({
      confirmation: deleteConfirmationSchema.shape.confirmation.optional(),
      finalBackup: z.boolean(),
      password: deleteConfirmationSchema.shape.password.optional(),
    })
  )
  .handler(({ data }) => retryResourceDeletionHandler(data))

export const cancelResourceDeletion = createServerFn({ method: "POST" })
  .validator(targetSchema)
  .handler(({ data }) => cancelResourceDeletionHandler(data))
