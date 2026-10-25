import { createServerFn } from "@tanstack/react-start"
import { z } from "zod"

import { requireEligibleResourceUser } from "@/server/auth"
import {
  serverReferenceSchema,
  startServerMigrationInputSchema,
} from "@/lib/server-migration-input"

/** What the Move or duplicate dialog offers for a game server. */
export const previewServerMigration = createServerFn({ method: "POST" })
  .validator(serverReferenceSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { previewServerMigrationHandler } =
      await import("@/server/server-migrations.server")
    return previewServerMigrationHandler(user, data)
  })

/** Starts copying a game server to a new one, in the background. */
export const startServerMigration = createServerFn({ method: "POST" })
  .validator(startServerMigrationInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { startServerMigrationHandler } =
      await import("@/server/server-migrations.server")
    return startServerMigrationHandler(user, data)
  })

/** The signed-in person's running and recently finished copies. */
export const getServerMigrations = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const { listServerMigrationsHandler } =
      await import("@/server/server-migrations.server")
    return listServerMigrationsHandler(user)
  }
)

/** Stops one of the signed-in person's copies and removes what it made. */
export const cancelServerMigration = createServerFn({ method: "POST" })
  .validator(z.object({ id: z.uuid() }))
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const { cancelServerMigrationHandler } =
      await import("@/server/server-migrations.server")
    await cancelServerMigrationHandler(user, data.id)
    return { cancelled: true }
  })
