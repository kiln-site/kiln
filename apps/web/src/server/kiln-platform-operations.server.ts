import type { RelayPlatformActionInput } from "@workspace/contracts"
import { Effect } from "effect"

import { promiseEffect } from "@/effect/promise"
import { isPlatformAdmin } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { exclusive, hearthKey, shared } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  databaseRpc,
  platformDatabaseRelay,
  platformRelay,
} from "@/server/platform-access.server"

// Changes to Kiln's own services and database, as operations
// (docs/hearth-operations.md). An edit to Hearth's database holds Hearth
// shared; what replaces or restarts it holds Hearth whole, so it waits for
// none of them, nor for an update or a platform backup.

const platformAdministrator = (user: AuthenticatedUser | null) =>
  signedIn(user).pipe(
    Effect.filterOrFail(
      isPlatformAdmin,
      () =>
        new Error("Only a platform administrator can manage Kiln's services")
    )
  )

const signedInPerson = async () => ({
  user: await requireEligibleResourceUser(),
})

type KilnDatabaseWrite = {
  readonly payload: { readonly readOnly?: boolean; readonly request: unknown }
  readonly relayId: string
}

const writeKilnDatabase = operation<KilnDatabaseWrite>()({
  name: "kilnDatabase.write",
  doing: "Changing Kiln's database",
  authorize: ({ user }) => platformAdministrator(user),
  locks: () => [shared(hearthKey)],
  run: ({ context: user, input }) =>
    promiseEffect(() =>
      kilnDatabaseRequest(
        user,
        input.relayId,
        "relay.platform.database.write",
        input.payload
      )
    ),
  audit: ({ input }) => ({
    id: "platform",
    kind: "platform",
    relayId: input.relayId,
  }),
})

/** A query or row change in Hearth's own database, through its Relay. */
export async function changeKilnDatabase(
  input: KilnDatabaseWrite
): Promise<unknown> {
  return runOperationPromise(writeKilnDatabase, input, await signedInPerson())
}

/** A read of Hearth's own database, through its Relay. */
export async function readKilnDatabase(
  relayId: string,
  payload: { readonly request: unknown }
): Promise<unknown> {
  const { requirePlatformAdministrator } =
    await import("@/server/platform-access.server")
  return kilnDatabaseRequest(
    await requirePlatformAdministrator(),
    relayId,
    "relay.platform.database.read",
    payload
  )
}

async function kilnDatabaseRequest(
  user: AuthenticatedUser,
  relayId: string,
  operation: "relay.platform.database.read" | "relay.platform.database.write",
  payload: { readonly readOnly?: boolean; readonly request: unknown }
): Promise<unknown> {
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

// Replaces what Hearth's database holds, so it holds Hearth whole.
const importIntoKilnDatabase = operation<{ readonly content: string }>()({
  name: "kilnDatabase.import",
  doing: "Importing into Kiln's database",
  authorize: ({ user }) => platformAdministrator(user),
  locks: () => [exclusive(hearthKey)],
  run: ({ input }) =>
    promiseEffect(async () => {
      const [
        { importKilnDatabaseSql },
        { runAppEffect },
        { kilnInstallationId },
        { holdingRelayVolumeReferences },
      ] = await Promise.all([
        import("@/server/kiln-database-dump.server"),
        import("@/effect/runtime"),
        import("@/effect/installation"),
        import("@/lib/volume-reference-hold.server"),
      ])
      // The App configurations it brings may name volumes these don't, so
      // every Relay stops counting what this Hearth sent before it commits.
      await holdingRelayVolumeReferences(() =>
        runAppEffect(
          "kilnDatabase.import",
          importKilnDatabaseSql(input.content, {
            installationId: kilnInstallationId(),
            now: Date.now(),
          })
        )
      )
      return { imported: true as const }
    }),
  audit: () => ({ id: "platform", kind: "platform" }),
})

/** Runs a Kiln export against Hearth's own database. */
export async function importKilnExport(content: string) {
  return runOperationPromise(
    importIntoKilnDatabase,
    { content },
    await signedInPerson()
  )
}

// Restarts or repairs Kiln's services on their Relay, so it holds Hearth
// whole. It ends once the Relay has done it, or Hearth restarts with it.
const kilnPlatformAction = operation<
  RelayPlatformActionInput & { readonly relayId: string }
>()({
  name: "kilnPlatform.action",
  doing: "Restarting Kiln's services",
  authorize: ({ user }) => platformAdministrator(user),
  locks: () => [exclusive(hearthKey)],
  run: ({ context: user, input: { relayId, ...action } }) =>
    promiseEffect(async () => {
      const [relay, { relayRpc }] = await Promise.all([
        platformRelay(relayId),
        import("@/lib/relay-connection"),
      ])
      return relayRpc(relay, "relay.platform.action", action, 240_000, user.id)
    }),
  audit: ({ input }) => ({
    id: "platform",
    kind: "platform",
    relayId: input.relayId,
  }),
})

/** Restarts one of Kiln's services, or repairs them, on their Relay. */
export async function runKilnServiceAction(
  input: RelayPlatformActionInput & { readonly relayId: string }
): Promise<unknown> {
  return runOperationPromise(kilnPlatformAction, input, await signedInPerson())
}
