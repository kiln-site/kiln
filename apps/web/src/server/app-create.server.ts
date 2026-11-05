import { randomBytes, randomUUID } from "node:crypto"

import { relayAppSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  appNameExistsEffect,
  createAppRecordEffect,
  deleteAppRecordEffect,
} from "@/effect/managed-apps"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import {
  abandonPreparedProvisioning,
  claimPreparedProvisioning,
} from "@/lib/provisioning.server"
import { outsideOperation } from "@/operations/current"
import {
  exclusive,
  partKey,
  relayKey,
  resourceKey,
  shared,
} from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { publishAppChange } from "@/server/app-access"
import { appDatabaseEnvironment } from "@/server/app-database-environment.server"
import {
  createDatabase,
  type CreateDatabaseInput,
} from "@/server/database-create.server"
import {
  databaseRpc,
  requiredCredential,
  requiredRelay,
} from "@/server/managed-database-access"

export interface CreateAppInput {
  // A database to connect it to from the start, a new one or one on its
  // Relay, whose credentials go in its environment.
  database?:
    | (Pick<
        CreateDatabaseInput,
        "databaseName" | "engine" | "name" | "username"
      > & { kind: "new" })
    | { id: string; kind: "existing" }
  name: string
  relayId: string
}

interface CreateAppIds {
  /** The App's and a new database's, settled as it's asked for. */
  databaseId: string | null
  id: string
}

// Settled once, not in `authorize`, which runs again after a wait: new IDs
// would be new lanes, and it would keep taking its turn again.
export const withNewAppIds = (input: CreateAppInput) => ({
  ...input,
  databaseId:
    input.database?.kind === "existing"
      ? input.database.id
      : input.database
        ? randomBytes(20).toString("hex")
        : null,
  id: randomBytes(20).toString("hex"),
})

const cancelledSchema = z.object({ cancelled: z.boolean() })

// What connecting an App to an existing database at its creation takes:
// joining it, and reading the credentials its environment gets a copy of.
const existingDatabasePermissions = [
  "database.network.write",
  "database.credentials.read",
] as const

// Holds the App it creates, by the ID it was given, and its Relay
// shared, so the Relay isn't removed meanwhile. The Relay is read once
// admitted, so one removed since can't gain the App. A database created
// with it is held whole. An existing one holds its connections,
// and its credentials shared, so a rotation waits for the copy going into
// the App's environment; copying them takes reading them, so joining alone
// isn't enough.
export const createAppOperation = operation<CreateAppInput & CreateAppIds>()({
  name: "app.create",
  doing: "Creating this App",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(async () => {
          const { database, relayId } = input
          const permissions: Array<{
            databaseId?: string
            permission: AccessPermission
          }> = [{ permission: "app.create" }]
          if (database?.kind === "new") {
            permissions.push({ permission: "database.create" })
          } else if (database) {
            for (const permission of existingDatabasePermissions) {
              permissions.push({ databaseId: database.id, permission })
            }
          }
          for (const need of permissions) {
            await requireRelayPermission({ ...need, relayId, user: person })
          }
        })
      )
    ),
  locks: ({ input }) => {
    const { databaseId, id } = input
    const database =
      databaseId === null
        ? null
        : resourceKey("database", input.relayId, databaseId)
    return [
      exclusive(resourceKey("app", input.relayId, id)),
      shared(relayKey(input.relayId)),
      ...(database === null
        ? []
        : input.database?.kind === "new"
          ? [exclusive(database)]
          : [
              exclusive(partKey(database, "connections")),
              shared(partKey(database, "credentials")),
            ]),
    ]
  },
  run: ({ context: user, input }) =>
    promiseEffect(() => createAppHandler(user, input)),
  audit: ({ input }) => ({
    id: input.id,
    kind: "app",
    relayId: input.relayId,
  }),
})

async function createAppHandler(
  user: AuthenticatedUser,
  data: CreateAppInput & CreateAppIds
) {
  const { databaseId, id } = data
  const relay = await requiredRelay(data.relayId)
  const nameExists = await runAppEffect(
    "apps.name.preflight",
    appNameExistsEffect(relay.id, data.name)
  )
  if (nameExists) {
    throw new Error(
      `An app named "${data.name}" already exists on ${relay.name}`
    )
  }
  // The database comes first: one that can't be made leaves no App, and
  // the App's first deployment already has the variables it's connected by.
  if (data.database?.kind === "new" && databaseId !== null) {
    await runOperationPromise(
      createDatabase,
      {
        databaseName: data.database.databaseName,
        engine: data.database.engine,
        id: databaseId,
        name: data.database.name,
        relayId: relay.id,
        username: data.database.username,
      },
      { user }
    )
  }
  const environment =
    databaseId === null
      ? undefined
      : appDatabaseEnvironment(await requiredCredential(relay.id, databaseId))
  const cancel = () =>
    databaseRpc(
      relay,
      "app.provision.cancel",
      { appId: id },
      30_000,
      user.id
    ).then((result) => cancelledSchema.parse(result).cancelled)
  const unregister = () =>
    runAppEffect("apps.record.delete", deleteAppRecordEffect(relay.id, id))
  // Recorded first, so a job the Relay holds always has an app in Hearth to
  // show it and delete it from.
  await runAppEffect(
    "apps.record.create",
    createAppRecordEffect({
      appId: id,
      createdBy: user.id,
      environment,
      name: data.name,
      relayId: relay.id,
    })
  )
  // The Relay creates it in the background, and connects its database then,
  // whether or not that's still provisioning; it opens on its provisioning
  // page at once.
  const placeholder = await Effect.runPromise(
    promiseEffect(() =>
      databaseRpc(
        relay,
        "app.provision.prepare",
        {
          databaseIds: databaseId === null ? [] : [databaseId],
          id,
          idempotencyKey: randomUUID(),
          name: data.name,
        },
        30_000,
        user.id
      )
    ).pipe(
      Effect.map((value) => relayAppSchema.parse(value)),
      Effect.tapError(() => abandonPreparedProvisioning(cancel, unregister))
    )
  )
  await claimPreparedProvisioning({
    cancel,
    claim: () =>
      databaseRpc(relay, "app.provision.claim", { appId: id }, 30_000, user.id),
    unconfirmed: "If it stays waiting, delete it and create it again.",
    unregister,
  })
  publishAppChange(relay.id, true)
  generateAppHostname(relay.id, id)
  return {
    id: placeholder.id,
    relayId: relay.id,
    shortId: placeholder.shortId,
  }
}

// A new app gets an address under a vanity domain, as game servers do. In
// the background: it calls Cloudflare, and the app opens without it.
function generateAppHostname(relayId: string, appId: string) {
  // Creating the App doesn't wait for it: it takes the App's DNS lane on
  // its own, once creating it is done.
  outsideOperation(
    () =>
      void import("@/server/web-hostname-access.server").then(
        ({ generateAppHostnameBestEffort }) =>
          generateAppHostnameBestEffort({
            relayId,
            resourceId: appId,
            resourceType: "app",
          })
      )
  )
}
