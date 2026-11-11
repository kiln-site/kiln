import { createHash } from "node:crypto"

import {
  brickSourceLineage,
  isTailscaleNode,
  relaySnapshotSchema,
  type BrickRecipe,
} from "@workspace/contracts"
import { Clock, Effect, Schema } from "effect"

import {
  latestAppDeploymentsEffect,
  latestDeploymentStartedAtEffect,
} from "@/effect/app-deployments"
import type { Database } from "@/effect/database"
import {
  autoBrickUpdateAt,
  autoUpdateAt,
  claimImageUpdateEffect,
  currentBrickUpdate,
  currentImageUpdate,
  loadInstanceUpdateEffect,
  offeredBrickRevision,
  type InstanceUpdateKind,
} from "@/effect/instance-updates"
import {
  listRelayAppConfigsEffect,
  loadAppConfigEffect,
} from "@/effect/managed-apps"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { newestBrickRevision } from "@/lib/brick-revisions.server"
import {
  askAppDeploymentEffect,
  publishAppDeploymentChange,
} from "@/lib/app-deployments.server"
import { serverDeployDnsLocks } from "@/lib/dns-operations"
import type { PersistedRelay } from "@/lib/relay-registry"
import { publishServerDeploymentChange } from "@/lib/server-deployments.server"
import {
  exclusive,
  partKey,
  resourceKey,
  type LaneLock,
} from "@/operations/lanes"
import { inLanes, OperationBusyError } from "@/operations/operation"

// What differs by kind about updates: which instances have an image that
// could move, what tells a check apart from one about another image, and
// how one takes an update. Checking, recording, notifying and waiting are
// the same for every kind (`instance-updates.server.ts`).

/** An instance whose image is checked. */
export interface UpdateSubject {
  id: string
  /**
   * The image Hearth knows it names, which a check asks about. Null for a
   * kind that runs what its container was made from, which the Relay reads.
   */
  image: string | null
  name: string
}

/** An update that has waited as long as its instance asks, of one thing. */
export type DueUpdate =
  | { digest: string; of: "image" }
  | { of: "brick"; revision: number }

export interface UpdatedKind {
  kind: InstanceUpdateKind
  /** The kind as a Relay request names it. */
  relayKind: "app" | "database" | "instance"
  /** The kind as lanes, access and notifications name it. */
  resourceType: "app" | "database" | "instance"
  /** Those on a Relay whose image could move. */
  subjects: (
    relay: PersistedRelay
  ) => Effect.Effect<ReadonlyArray<UpdateSubject>, unknown, Database>
  /**
   * The image one names now, as `UpdateSubject.image` has it, or undefined
   * once it's gone or names nothing that moves.
   */
  namedImage: (
    relayId: string,
    instanceId: string
  ) => Effect.Effect<string | null | undefined, unknown, Database>
  /**
   * Whether it still follows the Brick its container says it was deployed
   * from. Left out for a kind that always does: an App can be detached from
   * its Brick, and runs on as it was until it next deploys.
   */
  followsBrick?: (
    relayId: string,
    instanceId: string
  ) => Effect.Effect<boolean, unknown, Database>
  /** When its newest deployment started, which may have changed what runs. */
  latestDeploymentStartedAt: (
    instanceId: string
  ) => Effect.Effect<string | null, unknown, Database>
  /**
   * How an operation that takes an update holds the instance: shared for
   * one that only asks for a deployment, whole for one that replaces its
   * container there and then.
   */
  updateLock: "shared" | "whole"
  /** What taking an update holds besides the instance. */
  updateAlsoLocks?: (
    relayId: string,
    instanceId: string
  ) => ReadonlyArray<LaneLock>
  /**
   * Takes the image update on offer for someone who asked, in an operation
   * of theirs that holds the instance as `updateLock` says.
   */
  deployUpdate: (
    relay: PersistedRelay,
    instanceId: string,
    userId: string
  ) => Effect.Effect<void, unknown, Database>
  /**
   * Installs the newest revision of its Brick for someone who asked, in an
   * operation of theirs. Left out for a kind that doesn't run Bricks yet.
   */
  installBrick?: (
    relay: PersistedRelay,
    instanceId: string,
    userId: string
  ) => Effect.Effect<void, unknown, Database>
  /**
   * Takes an update Kiln found due, on its own. Called holding nothing: it
   * judges again whether the update is still due once it holds the
   * instance, and does nothing if the instance is busy; the next check
   * that finds it due tries again.
   */
  autoUpdate: (
    relay: PersistedRelay,
    instanceId: string,
    due: DueUpdate
  ) => Effect.Effect<void, unknown, Database>
  /** Tells whoever watches the kind that what Kiln knows changed. */
  published: (relayId: string) => void
}

// An App checks while it deploys an image by tag: a digest never moves, and
// one built from a Dockerfile, a Compose file or a repository has no tag.
const movingAppImage = (config: { image: string; sourceType: string }) =>
  config.sourceType === "image" &&
  config.image !== "" &&
  !config.image.includes("@")

// It checks too while it follows a Brick, whose revisions it is offered
// whatever its image names.
const checkedApp = (app: {
  brick: unknown
  config: { image: string; sourceType: string }
}) =>
  movingAppImage(app.config) ||
  (app.brick !== null &&
    app.config.sourceType === "image" &&
    app.config.image !== "")

// An App takes a revision of its Brick as a database or a game server
// does, with what installing one is for an App: its configuration made
// again, and a deployment asked of its queue.
const appsFollow = () =>
  deploysAgain({
    doing: "Updating this App's Brick",
    install: async (relay, appId, newest, by) =>
      (
        await import("@/server/app-brick-revision.server")
      ).installAppBrickRevision(relay, appId, newest, by),
    kind: "app",
    locks: appConfigLocks,
    name: "app.updates.auto",
    redeploy: (relay, appId, by) =>
      runAppEffect(
        "apps.deploy",
        askAppDeploymentEffect({ appId, relayId: relay.id, ...by })
      ),
  })

// Making an App again from its Brick changes its configuration.
const appConfigLocks = (relayId: string, appId: string) => [
  exclusive(partKey(resourceKey("app", relayId, appId), "config")),
]

const apps: UpdatedKind = {
  kind: "app",
  relayKind: "app",
  resourceType: "app",
  subjects: (relay) =>
    listRelayAppConfigsEffect(relay.id).pipe(
      Effect.map((records) =>
        records.flatMap((app) =>
          checkedApp(app)
            ? [{ id: app.appId, image: app.config.image, name: app.name }]
            : []
        )
      )
    ),
  namedImage: (relayId, appId) =>
    loadAppConfigEffect(relayId, appId).pipe(
      Effect.map((app) =>
        app && checkedApp(app) ? app.config.image : undefined
      )
    ),
  followsBrick: (relayId, appId) =>
    loadAppConfigEffect(relayId, appId).pipe(
      Effect.map((app) => (app?.brick ?? null) !== null)
    ),
  latestDeploymentStartedAt: (appId) =>
    latestAppDeploymentsEffect(appId).pipe(
      Effect.map(({ latest }) => latest?.startedAt ?? null)
    ),
  // An App's update is asked of its deployment queue: behind any deployment
  // running, joining any deploy already asked for. The queue deploys the
  // update on offer when its turn comes, and judges Kiln's own again then.
  updateLock: "shared",
  // A revision of its Brick makes its configuration again, which is held
  // while it does.
  updateAlsoLocks: appConfigLocks,
  deployUpdate: (relay, appId, userId) =>
    askAppDeploymentEffect({
      appId,
      relayId: relay.id,
      trigger: "update",
      userId,
    }).pipe(Effect.asVoid),
  installBrick: (relay, appId, userId) =>
    appsFollow().installBrick?.(relay, appId, userId) ?? Effect.void,
  autoUpdate: (relay, appId, due) =>
    due.of === "brick"
      ? appsFollow().autoUpdate(relay, appId, due)
      : askAppDeploymentEffect({
          appId,
          relayId: relay.id,
          trigger: "update",
        }).pipe(Effect.asVoid),
  published: publishAppDeploymentChange,
}

// A game server and a database take an update by deploying again: the
// same recipe, which pulls the tag their container was made from, or a
// newer revision of it. It is the operation a redeploy is, holding the
// instance whole. A person's is their own operation, like any other they
// start. Kiln's own runs only when nothing else holds the instance, and
// decides again once it holds it, so nothing waits in a queue where its
// people could change their minds behind it.
const deploysAgain = (definition: {
  doing: string
  install: (
    relay: PersistedRelay,
    instanceId: string,
    newest: {
      definition: BrickRecipe
      name: string
      revision: number
      source: string
    },
    by: { userId: string | null }
  ) => Promise<unknown>
  kind: "app" | "database" | "server"
  locks: (relayId: string, instanceId: string) => ReadonlyArray<LaneLock>
  name: string
  redeploy: (
    relay: PersistedRelay,
    instanceId: string,
    by: { trigger: "update"; userId: string | null }
  ) => Promise<unknown>
}): Pick<
  UpdatedKind,
  "autoUpdate" | "deployUpdate" | "installBrick" | "updateLock"
> => {
  // The Brick it runs, as a check since its last deployment found it. A
  // deployment may have changed its Brick, and what was seen before one is
  // never installed from.
  const seenBrick = Effect.fnUntraced(function* (instanceId: string) {
    const [saved, startedAt] = yield* Effect.all([
      loadInstanceUpdateEffect(instanceId),
      latestDeploymentStartedAtEffect(definition.kind, instanceId),
    ])
    return { brick: currentBrickUpdate(saved, startedAt), saved }
  })
  // Kiln's own, judged holding the instance: still set to update on its
  // own, the update still the one on offer and not passed over, and its
  // wait over. Each image or revision is tried once, however it goes.
  const ownUpdate = Effect.fnUntraced(function* (
    relay: PersistedRelay,
    instanceId: string,
    due: DueUpdate
  ) {
    const now = yield* Clock.currentTimeMillis
    const saved = yield* loadInstanceUpdateEffect(instanceId)
    if (due.of === "image") {
      const update = currentImageUpdate(
        saved,
        null,
        yield* latestDeploymentStartedAtEffect(definition.kind, instanceId)
      )
      const at = update && autoUpdateAt(update)
      if (
        !update ||
        at === null ||
        at > now ||
        update.latestDigest !== due.digest ||
        !(yield* claimUpdateEffect(instanceId, due.digest))
      ) {
        return
      }
      yield* promiseEffect(() =>
        definition.redeploy(relay, instanceId, {
          trigger: "update",
          userId: null,
        })
      )
      return
    }
    const { brick } = yield* seenBrick(instanceId)
    const at = saved && autoBrickUpdateAt(saved)
    if (
      !saved ||
      !brick ||
      at === null ||
      at > now ||
      offeredBrickRevision(saved) !== due.revision
    ) {
      return
    }
    // The revision that waited, never one that came after it, which is
    // offered and waits in its own turn.
    const { source } = brick
    const newest = yield* promiseEffect(() => newestBrickRevision(source))
    if (
      !newest ||
      newest.revision !== due.revision ||
      !(yield* claimUpdateEffect(
        instanceId,
        revisionClaim(source, due.revision)
      ))
    ) {
      return
    }
    yield* promiseEffect(() =>
      definition.install(relay, instanceId, newest, { userId: null })
    )
  })
  return {
    updateLock: "whole",
    deployUpdate: (relay, instanceId, userId) =>
      promiseEffect(() =>
        definition.redeploy(relay, instanceId, { trigger: "update", userId })
      ).pipe(Effect.asVoid),
    installBrick: (relay, instanceId, userId) =>
      Effect.gen(function* () {
        const { brick } = yield* seenBrick(instanceId)
        if (!brick) {
          return yield* Effect.fail(
            new Error(
              "Kiln hasn't checked what this runs since it last deployed. Check now, then update its Brick."
            )
          )
        }
        const newest = yield* promiseEffect(() =>
          newestBrickRevision(brick.source)
        )
        if (!newest) {
          return yield* Effect.fail(
            new Error("No catalog has its Brick any more")
          )
        }
        yield* promiseEffect(() =>
          definition.install(relay, instanceId, newest, { userId })
        )
      }),
    autoUpdate: (relay, instanceId, due) =>
      inLanes(
        definition.name,
        definition.doing,
        definition.locks(relay.id, instanceId),
        ownUpdate(relay, instanceId, due),
        { onlyIfFree: true }
      ).pipe(
        Effect.asVoid,
        // Busy: the next check that finds it due tries again.
        Effect.catchIf(Schema.is(OperationBusyError), () => Effect.void)
      ),
  }
}

// An attempt at an update is kept by what it was of, so Kiln's own tries
// each once. A revision is only its Brick's: the same number of another
// Brick, as after a change of Brick, is another update.
const claimUpdateEffect = (instanceId: string, claim: string) =>
  claimImageUpdateEffect(instanceId, claim, crypto.randomUUID())

const revisionClaim = (source: string, revision: number) =>
  `revision:${createHash("sha256")
    .update(brickSourceLineage(source))
    .digest("hex")
    .slice(0, 16)}:${revision}`

const deploys = () => import("@/server/instance-deploy.server")

// A Relay's game servers, as it lists them: Hearth keeps no record of its
// own of what each runs.
const relayServers = (relay: PersistedRelay) =>
  promiseEffect(async () => {
    const { requestRelay } = await import("@/server/bricks.server")
    return relaySnapshotSchema
      .parse(await requestRelay(relay, "/v1/snapshot"))
      .instances.filter(
        // A Tailscale network's node isn't a game server to anyone.
        (instance) => instance.managedByRelay && !isTailscaleNode(instance)
      )
  })

const databases: UpdatedKind = {
  kind: "database",
  relayKind: "database",
  resourceType: "database",
  subjects: (relay) =>
    listManagedDatabaseRecordsEffect().pipe(
      Effect.map((records) =>
        records.flatMap((database) =>
          database.relayId === relay.id
            ? [{ id: database.databaseId, image: null, name: database.name }]
            : []
        )
      )
    ),
  namedImage: (relayId, databaseId) =>
    listManagedDatabaseRecordsEffect().pipe(
      Effect.map((records) =>
        records.some(
          (database) =>
            database.relayId === relayId && database.databaseId === databaseId
        )
          ? null
          : undefined
      )
    ),
  latestDeploymentStartedAt: (databaseId) =>
    latestDeploymentStartedAtEffect("database", databaseId),
  ...deploysAgain({
    doing: "Updating this database",
    install: async (relay, databaseId, newest, by) =>
      (await deploys()).installDatabaseBrickRevision(
        relay,
        databaseId,
        newest,
        by
      ),
    kind: "database",
    locks: (relayId, databaseId) => [
      exclusive(resourceKey("database", relayId, databaseId)),
    ],
    name: "database.updates.auto",
    redeploy: async (relay, databaseId, by) =>
      (await deploys()).redeployDatabase(relay, databaseId, by),
  }),
  published: publishServerDeploymentChange,
}

const servers: UpdatedKind = {
  kind: "server",
  relayKind: "instance",
  resourceType: "instance",
  subjects: (relay) =>
    relayServers(relay).pipe(
      Effect.map((instances) =>
        instances.map(({ id, name }) => ({ id, image: null, name }))
      )
    ),
  namedImage: (relayId, instanceId) =>
    promiseEffect(async () => {
      const { requiredRelay } = await import("@/server/bricks.server")
      return requiredRelay(relayId)
    }).pipe(
      Effect.flatMap(relayServers),
      Effect.map((instances) =>
        instances.some((instance) => instance.id === instanceId)
          ? null
          : undefined
      )
    ),
  latestDeploymentStartedAt: (instanceId) =>
    latestDeploymentStartedAtEffect("server", instanceId),
  // Its domains name its address, as for any deploy of one.
  updateAlsoLocks: serverDeployDnsLocks,
  ...deploysAgain({
    doing: "Updating this game server",
    install: async (relay, instanceId, newest, by) =>
      (await deploys()).installServerBrickRevision(
        relay,
        instanceId,
        newest,
        by
      ),
    kind: "server",
    locks: (relayId, instanceId) => [
      exclusive(resourceKey("instance", relayId, instanceId)),
      ...serverDeployDnsLocks(relayId, instanceId),
    ],
    name: "instance.updates.auto",
    redeploy: async (relay, instanceId, by) =>
      (await deploys()).redeployServer(relay, instanceId, by),
  }),
  published: publishServerDeploymentChange,
}

/** Every kind that takes updates. */
export const updatedKinds: ReadonlyArray<UpdatedKind> = [
  apps,
  databases,
  servers,
]

export function updatedKind(kind: InstanceUpdateKind): UpdatedKind {
  const found = updatedKinds.find((candidate) => candidate.kind === kind)
  if (!found) throw new Error(`${kind} doesn't take updates yet`)
  return found
}
