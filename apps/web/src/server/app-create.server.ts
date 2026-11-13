import { randomUUID } from "node:crypto"

import {
  appEnvironmentWith,
  relayAppSchema,
  type AppBrickDeploy,
  type AppBrickWeb,
  type BrickVariableValue,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  appNameExistsEffect,
  createAppRecordEffect,
  deleteAppRecordEffect,
  sendSavedAppVolumeReferencesEffect,
  type AppBrickRecord,
} from "@/effect/managed-apps"
import { reserveInstanceIdEffect } from "@/effect/instance-ids"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { PersistedRelay } from "@/lib/relay-registry"
import type { AccessPermission } from "@/lib/permissions"
import {
  abandonPreparedProvisioning,
  claimPreparedProvisioning,
} from "@/lib/provisioning.server"
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
import {
  brickVolumeLocks,
  brickVolumeMounts,
  brickVolumes,
  makeBrickVolumes,
  type BrickVolume,
} from "@/server/app-brick-volumes.server"
import { appBrickFolders, installedAppBrick } from "@/server/app-bricks.server"
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
  /** A volume for each folder its Brick keeps, settled with them. */
  volumes: ReadonlyArray<BrickVolume>
}

// Settled once, not in `authorize`, which runs again after a wait: new IDs
// would be new lanes, and it would keep taking its turn again. Reserved for
// the person's request, so retrying the same create reserves nothing new.
// The volumes its Brick's folders are kept on are settled with them: they
// are lanes it holds too.
export const withNewAppIdsEffect = Effect.fn("apps.create.reserveIds")(
  function* (input: CreateAppInput, userId: string) {
    const folders = yield* promiseEffect(() =>
      appBrickFolders(input.brick, userId)
    )
    const requestKey = `app.create:${userId}:${input.idempotencyKey}`
    const id = yield* reserveInstanceIdEffect("app", requestKey)
    const databaseId =
      input.database?.kind === "existing"
        ? input.database.id
        : input.database
          ? yield* reserveInstanceIdEffect("database", `${requestKey}:database`)
          : null
    return {
      ...input,
      databaseId,
      id,
      volumes: brickVolumes({ id, name: input.name }, folders),
    } satisfies CreateAppInput & CreateAppIds
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
      ...brickVolumeLocks(input.relayId, input.volumes),
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
  const { deployable, web, ...created } = await runOperationPromise(
    createAppOperation,
    await withNewAppIds(data, user.id),
    { user }
  )
  await addressNewApp(user, { ...created, web })
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
  const { deploys, follows } = await installedAppBrick(
    data.brick,
    data.variables ?? {},
    user.id
  )
  // A Brick that publishes ports on the Relay, or carries the file its
  // App runs, takes what doing either in an App's settings does: a
  // Compose file can bind the node's own files, and creating an App alone
  // opens and writes neither.
  if (
    (deploys.ports?.length ?? 0) > 0 ||
    (deploys.type !== "image" && deploys.content !== undefined)
  ) {
    await requireRelayPermission({
      permission: "app.manage",
      relayId: relay.id,
      user,
    })
  }
  // What it holds was settled from the folders the Brick kept then.
  if (
    JSON.stringify(deploys.volumes) !==
    JSON.stringify(data.volumes.map(({ folder }) => folder))
  ) {
    throw new Error("This Brick changed while it was installed. Try again.")
  }
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
  const connected =
    databaseId === null
      ? ""
      : appDatabaseEnvironment(await requiredCredential(relay.id, databaseId))
  // What its Brick sets goes in beside what reaches its database.
  const environment = appEnvironmentWith(connected, [], deploys.environment)
  const made = await provisionApp(user, relay, {
    brick: follows,
    databaseIds: databaseId === null ? [] : [databaseId],
    deploys,
    environment,
    id,
    name: data.name,
    volumes: data.volumes,
  })
  return {
    // An image, or a file its Brick carries, is all it needs to deploy; a
    // file's source is still to come.
    deployable: deploys.type === "image" || deploys.content !== undefined,
    id: made.id,
    relayId: relay.id,
    /** Where its Brick says its website answers. */
    web: deploys.web,
  }
}

/**
 * Records an App and has its Relay make it, connected to the databases
 * named, whatever it was installed from. Whoever calls it holds the App
 * and has checked the person may create it.
 */
export async function provisionApp(
  user: AuthenticatedUser,
  relay: PersistedRelay,
  app: {
    /** The Brick it follows, when it follows one. */
    brick?: AppBrickRecord | undefined
    /** Databases on its Relay it starts connected to. */
    databaseIds: ReadonlyArray<string>
    deploys: AppBrickDeploy
    environment: string | undefined
    id: string
    name: string
    /**
     * A volume for each folder its Brick keeps, which whoever calls holds
     * too. Made first, so the App is never kept without them.
     */
    volumes?: ReadonlyArray<BrickVolume>
  }
) {
  const { id } = app
  const volumes = app.volumes ?? []
  await makeBrickVolumes(user, relay, volumes)
  const cancel = () =>
    databaseRpc(
      relay,
      "app.provision.cancel",
      { appId: id },
      30_000,
      user.id
    ).then((result) => cancelledSchema.parse(result).cancelled)
  // Its Relay is told too that it names no volume any more: one made for
  // it stays, empty, and nothing should keep it from being deleted.
  const unregister = () =>
    runAppEffect(
      "apps.record.delete",
      deleteAppRecordEffect(relay.id, id).pipe(
        Effect.andThen(
          volumes.length > 0
            ? sendSavedAppVolumeReferencesEffect(relay.id, id)
            : Effect.void
        )
      )
    )
  // Recorded first, so a job the Relay holds always has an app in Hearth to
  // show it and delete it from.
  await runAppEffect(
    "apps.record.create",
    createAppRecordEffect({
      appId: id,
      ...(app.brick ? { brick: app.brick } : {}),
      createdBy: user.id,
      deploys: {
        ...(app.deploys.type === "image"
          ? { image: app.deploys.image, sourceType: "image" as const }
          : {
              sourceType: app.deploys.type,
              // The file its Brick carries is the App's own from the start.
              ...(app.deploys.content === undefined
                ? {}
                : { [app.deploys.type]: app.deploys.content }),
            }),
        // Its Brick's `ready` command is its container's health check.
        ...(app.deploys.ready === undefined
          ? {}
          : { healthcheck: { command: app.deploys.ready } }),
        // What its Brick starts it with, and publishes on its Relay.
        ...(app.deploys.command === undefined
          ? {}
          : { command: app.deploys.command }),
        ...(app.deploys.ports === undefined
          ? {}
          : { ports: [...app.deploys.ports] }),
      },
      environment: app.environment,
      mounts: brickVolumeMounts(volumes),
      name: app.name,
      relayId: relay.id,
    })
  )
  // The Relay creates it in the background, and connects its databases
  // then, whether or not they're still provisioning; it opens on its
  // provisioning page at once.
  const placeholder = await Effect.runPromise(
    promiseEffect(() =>
      databaseRpc(
        relay,
        "app.provision.prepare",
        {
          databaseIds: [...app.databaseIds],
          id,
          idempotencyKey: randomUUID(),
          name: app.name,
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
  return { id: placeholder.id }
}

// As long as creating an App waits for its address to be routed, so its
// first deployment carries the route. Cloudflare is asked along the way;
// when it is slow, the route follows the App instead.
const ADDRESS_WAIT_MS = 8_000

/**
 * Gives a new App its address under a vanity domain, as game servers get
 * one, once it is made. One whose Brick says where its website answers is
 * routed there too, and that is waited for a little, since a Relay behind
 * someone else's proxy only takes a route with a deployment. Creating the
 * App never fails for its address: without one it opens all the same.
 */
export async function addressNewApp(
  user: AuthenticatedUser,
  app: { id: string; relayId: string; web?: AppBrickWeb | undefined }
) {
  const { web } = app
  // An address alone changes nothing a deployment carries, so it follows
  // the App, in the background.
  if (web === undefined) {
    void import("@/server/web-hostname-access.server").then(
      ({ generateAppHostnameBestEffort }) =>
        generateAppHostnameBestEffort({
          relayId: app.relayId,
          resourceId: app.id,
          resourceType: "app",
        })
    )
    return
  }
  const addressed = import("@/server/web-routes.server").then(
    ({ serveNewAppBestEffort }) =>
      serveNewAppBestEffort(user, {
        appId: app.id,
        relayId: app.relayId,
        web,
      })
  )
  await Promise.race([
    addressed,
    new Promise((resolve) => setTimeout(resolve, ADDRESS_WAIT_MS)),
  ])
}
