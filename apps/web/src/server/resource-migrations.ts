import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { requireEligibleResourceUser } from "@/server/auth"
import {
  resourceMigrationServingInputSchema,
  resourceReferenceSchema,
  startResourceMigrationInputSchema,
} from "@/lib/resource-migration-input"

/** What the Move or duplicate dialog offers for one resource. */
export const previewResourceMigration = createServerFn({ method: "GET" })
  .validator(resourceReferenceSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { previewResourceMigrationHandler } =
      await import("@/server/resource-migrations.server")
    return previewResourceMigrationHandler(user, data)
  })

/** Whether domains moved with a resource to a Relay would work there. */
export const getResourceMigrationServing = createServerFn({ method: "GET" })
  .validator(resourceMigrationServingInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { resourceMigrationServingHandler } =
      await import("@/server/resource-migrations.server")
    return resourceMigrationServingHandler(user, data)
  })

/** Starts copying a resource to a new one, in the background. */
export const startResourceMigration = createServerFn({ method: "POST" })
  .validator(startResourceMigrationInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { startResourceMigrationHandler } =
      await import("@/server/resource-migrations.server")
    return startResourceMigrationHandler(user, data)
  })

/** The signed-in person's running and recently finished copies. */
export const getResourceMigrations = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const { listResourceMigrationsHandler } =
      await import("@/server/resource-migrations.server")
    return listResourceMigrationsHandler(user)
  }
)

/** Stops one of the signed-in person's copies and removes what it made. */
export const cancelResourceMigration = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { cancelResourceMigrationHandler } =
      await import("@/server/resource-migrations.server")
    await cancelResourceMigrationHandler(user, data.id)
    return { cancelled: true }
  })
