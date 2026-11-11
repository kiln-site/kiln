import { randomUUID } from "node:crypto"

import { relayAppSchema, type BrickVariableValue } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  appNameExistsEffect,
  createAppRecordEffect,
  deleteAppRecordEffect,
} from "@/effect/managed-apps"
import { reserveInstanceIdEffect } from "@/effect/instance-ids"
import { promiseEffect, recoverPromise } from "@/effect/promise"
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
import { installedAppBrick } from "@/server/app-bricks.server"
import { askAppDeploy } from "@/server/app-deploy-ask.server"
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
  /** The App Brick it is installed from, by its source. */
  brick: string
  // A database to connect it to from the start, a new one or one on its
  // Relay, whose credentials go in its environment.
  database?:
    | (Pick<
        CreateDatabaseInput,
        "brick" | "databaseName" | "name" | "username" | "variables"
      > & { kind: "new" })
    | { id: string; kind: "existing" }
  // The same for every try of one create, so a retry gets the same IDs.
  idempotencyKey: string
  name: string
  relayId: string
  /** Its Brick's answers. */
  variables?: Record<string, BrickVariableValue>
}

interface CreateAppIds {
  /** The App's and a new database's, settled as it's asked for. */
  databaseId: string | null
  id: string
}

// Settled once, not in `authorize`, which runs again after a wait: new IDs
// would be new lanes, and it would keep taking its turn again. Reserved for
// the person's request, so retrying the same create reserves nothing new.
export const withNewAppIdsEffect = Effect.fn("apps.create.reserveIds")(
  function* (input: CreateAppInput, userId: string) {
    const requestKey = `app.create:${userId}:${input.idempotencyKey}`
    const id = yield* reserveInstanceIdEffect("app", requestKey)
    const databaseId =
      input.database?.kind === "existing"
        ? input.database.id
        : input.database
          ? yield* reserveInstanceIdEffect("database", `${requestKey}:database`)
          : null
    return { ...input, databaseId, id } satisfies CreateAppInput & CreateAppIds
  }
)

function withNewAppIds(input: CreateAppInput, userId: string) {
  return runAppEffect(
    "apps.create.reserveIds",
    withNewAppIdsEffect(input, userId)
  )
}

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

/**
 * Creates an App for someone and, when its Brick gave it something to run,
 * asks for its first deployment once its Relay has made it. That is a
 * deploy of its own, which whoever created it may not be allowed: the App
 * exists either way, and says why it wasn't deployed.
 */
export async function createAppFor(
  user: AuthenticatedUser,
  data: CreateAppInput
) {
  const { deployable, ...created } = await runOperationPromise(
    createAppOperation,
    await withNewAppIds(data, user.id),
    { user }
  )
  if (!deployable) return { ...created, deployError: null }
  const deployError = await recoverPromise(
    () =>
      runOperationPromise(
        askAppDeploy,
        {
          appId: created.id,
          awaitProvisioning: true,
          relayId: created.relayId,
          trigger: "manual",
        },
        { user }
      ).then(() => null),
    (cause) => (cause instanceof Error ? cause.message : String(cause))
  )
  return { ...created, deployError }
}

async function createAppHandler(
  user: AuthenticatedUser,
  data: CreateAppInput & CreateAppIds
) {
  const { databaseId, id } = data
  const relay = await requiredRelay(data.relayId)
  // Before anything is made: a Brick or an answer Kiln can't install from
  // leaves nothing behind.
  const deploys = await installedAppBrick(data.brick, data.variables ?? {})
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
        brick: data.database.brick,
        databaseName: data.database.databaseName,
        id: databaseId,
        name: data.database.name,
        relayId: relay.id,
        username: data.database.username,
        variables: data.database.variables,
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
      deploys:
        deploys.type === "image"
          ? { image: deploys.image, sourceType: "image" }
          : { sourceType: deploys.type },
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
    // An image is all it needs to deploy; a file's source is still to come.
    deployable: deploys.type === "image",
    id: placeholder.id,
    relayId: relay.id,
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
