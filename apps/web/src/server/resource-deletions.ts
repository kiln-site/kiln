import { relayIdSchema } from "@workspace/contracts"
import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { deleteConfirmationSchema } from "@/lib/delete-confirmation"

import {
  cancelResourceDeletionHandler,
  getResourceDeletionHandler,
  retryResourceDeletionHandler,
} from "@/server/resource-deletions.server"

// A game server's or database's deletion that's running, or that stopped
// for someone to try again or keep it.
const targetSchema = z.strictObject({
  kind: z.enum(["instance", "database"]),
  relayId: relayIdSchema,
  // Game servers and databases both have 40-hex IDs.
  resourceId: z.string().regex(/^[a-f0-9]{40}$/u),
})

export const getResourceDeletion = createServerFn({ method: "GET" })
  .validator(targetSchema)
  .handler(({ data }) => getResourceDeletionHandler(data))

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
