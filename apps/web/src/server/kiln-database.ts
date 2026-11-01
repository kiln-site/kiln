import { createServerFn } from "@tanstack/react-start"
import {
  databaseMutateInputSchema,
  databaseMutateResultSchema,
  databaseOverviewSchema,
  databaseQueryInputSchema,
  databaseQueryResultSchema,
  databaseRowsInputSchema,
  databaseRowsSchema,
  relayIdSchema,
} from "@workspace/contracts"
import { z } from "zod"

// Hearth's own database in the Viewer, through the Relay on its host, which
// reaches the MySQL container with the login Hearth itself uses. Platform
// administrators only; it holds everything Hearth knows.

const kilnDatabaseInputSchema = z.strictObject({ relayId: relayIdSchema })

export const getKilnDatabaseOverview = createServerFn({ method: "GET" })
  .validator(kilnDatabaseInputSchema)
  .handler(async ({ data }) => {
    const { readKilnDatabase } =
      await import("@/server/kiln-platform-operations.server")
    return databaseOverviewSchema.parse(
      await readKilnDatabase(data.relayId, { request: { action: "overview" } })
    )
  })

export const getKilnDatabaseRows = createServerFn({ method: "POST" })
  .validator(
    kilnDatabaseInputSchema.extend({ request: databaseRowsInputSchema })
  )
  .handler(async ({ data }) => {
    const { readKilnDatabase } =
      await import("@/server/kiln-platform-operations.server")
    return databaseRowsSchema.parse(
      await readKilnDatabase(data.relayId, { request: data.request })
    )
  })

export const runKilnDatabaseQuery = createServerFn({ method: "POST" })
  .validator(
    kilnDatabaseInputSchema.extend({
      readOnly: z.boolean(),
      request: databaseQueryInputSchema,
    })
  )
  .handler(async ({ data }) => {
    const { changeKilnDatabase } =
      await import("@/server/kiln-platform-operations.server")
    return databaseQueryResultSchema.parse(
      await changeKilnDatabase({
        payload: { readOnly: data.readOnly, request: data.request },
        relayId: data.relayId,
      })
    )
  })

export const mutateKilnDatabase = createServerFn({ method: "POST" })
  .validator(
    kilnDatabaseInputSchema.extend({ request: databaseMutateInputSchema })
  )
  .handler(async ({ data }) => {
    const { changeKilnDatabase } =
      await import("@/server/kiln-platform-operations.server")
    return databaseMutateResultSchema.parse(
      await changeKilnDatabase({
        payload: { request: data.request },
        relayId: data.relayId,
      })
    )
  })

// Runs a Kiln export against Hearth's own database, through Hearth's login;
// importKilnDatabaseSql says which it accepts.
export const importKilnDatabase = createServerFn({ method: "POST" })
  .validator(z.strictObject({ content: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { importKilnExport } =
      await import("@/server/kiln-platform-operations.server")
    return importKilnExport(data.content)
  })
