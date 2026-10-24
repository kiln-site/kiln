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
  .handler(async ({ data }) =>
    databaseOverviewSchema.parse(
      await kilnDatabaseRequest(data.relayId, "relay.platform.database.read", {
        request: { action: "overview" },
      })
    )
  )

export const getKilnDatabaseRows = createServerFn({ method: "POST" })
  .validator(
    kilnDatabaseInputSchema.extend({ request: databaseRowsInputSchema })
  )
  .handler(async ({ data }) =>
    databaseRowsSchema.parse(
      await kilnDatabaseRequest(data.relayId, "relay.platform.database.read", {
        request: data.request,
      })
    )
  )

export const runKilnDatabaseQuery = createServerFn({ method: "POST" })
  .validator(
    kilnDatabaseInputSchema.extend({
      readOnly: z.boolean(),
      request: databaseQueryInputSchema,
    })
  )
  .handler(async ({ data }) =>
    databaseQueryResultSchema.parse(
      await kilnDatabaseRequest(data.relayId, "relay.platform.database.write", {
        readOnly: data.readOnly,
        request: data.request,
      })
    )
  )

export const mutateKilnDatabase = createServerFn({ method: "POST" })
  .validator(
    kilnDatabaseInputSchema.extend({ request: databaseMutateInputSchema })
  )
  .handler(async ({ data }) =>
    databaseMutateResultSchema.parse(
      await kilnDatabaseRequest(data.relayId, "relay.platform.database.write", {
        request: data.request,
      })
    )
  )

async function kilnDatabaseRequest(
  relayId: string,
  operation: "relay.platform.database.read" | "relay.platform.database.write",
  payload: { readOnly?: boolean; request: unknown }
): Promise<unknown> {
  const { databaseRpc, platformDatabaseRelay, requirePlatformAdministrator } =
    await import("@/server/platform-access.server")
  const user = await requirePlatformAdministrator()
  const [relay, { databaseConnectionConfig }] = await Promise.all([
    platformDatabaseRelay(relayId),
    import("@/lib/database-config"),
  ])
  const login = databaseConnectionConfig()
  return databaseRpc(
    relay,
    operation,
    {
      ...payload,
      databaseName: login.database,
      password: login.password,
      username: login.user,
    },
    // The Relay stops database work after 25s; leave room for its reply.
    30_000,
    user.id
  )
}

// Runs a Kiln export against Hearth's own database, through Hearth's login;
// importKilnDatabaseSql says which it accepts.
export const importKilnDatabase = createServerFn({ method: "POST" })
  .validator(z.strictObject({ content: z.string().min(1) }))
  .handler(async ({ data }) => {
    const { requirePlatformAdministrator } =
      await import("@/server/platform-access.server")
    await requirePlatformAdministrator()
    const [
      { importKilnDatabaseSql },
      { runAppEffect },
      { kilnInstallationId },
    ] = await Promise.all([
      import("@/server/kiln-database-dump.server"),
      import("@/effect/runtime"),
      import("@/effect/installation"),
    ])
    await runAppEffect(
      "kilnDatabase.import",
      importKilnDatabaseSql(data.content, {
        installationId: kilnInstallationId(),
        now: Date.now(),
      })
    )
    return { imported: true }
  })
