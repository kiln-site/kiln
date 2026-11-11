import { isTailscaleNode, relaySnapshotSchema } from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Cause, Effect } from "effect"

import {
  latestAppDeploymentsEffect,
  latestDeploymentStartedAtEffect,
} from "@/effect/app-deployments"
import type { Database } from "@/effect/database"
import {
  claimImageUpdateEffect,
  type InstanceUpdateKind,
} from "@/effect/instance-updates"
import {
  listRelayAppConfigsEffect,
  loadAppConfigEffect,
} from "@/effect/managed-apps"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import {
  askAppDeploymentEffect,
  publishAppDeploymentChange,
} from "@/lib/app-deployments.server"
import { dnsKey } from "@/lib/dns-operations"
import type { PersistedRelay } from "@/lib/relay-registry"
import { publishServerDeploymentChange } from "@/lib/server-deployments.server"
import { outsideOperation } from "@/operations/current"
import { exclusive, resourceKey, type LaneLock } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"

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
  /** When its newest deployment started, which may have changed what runs. */
  latestDeploymentStartedAt: (
    instanceId: string
  ) => Effect.Effect<string | null, unknown, Database>
  /**
   * Asks for the update on offer, the image `digest` names, to be deployed:
   * by someone, or by Kiln (`userId` null) once it has waited.
   */
  deployUpdate: (
    relay: PersistedRelay,
    instanceId: string,
    userId: string | null,
    digest: string | null
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

const apps: UpdatedKind = {
  kind: "app",
  relayKind: "app",
  resourceType: "app",
  subjects: (relay) =>
    listRelayAppConfigsEffect(relay.id).pipe(
      Effect.map((records) =>
        records.flatMap((app) =>
          movingAppImage(app.config)
            ? [{ id: app.appId, image: app.config.image, name: app.name }]
            : []
        )
      )
    ),
  namedImage: (relayId, appId) =>
    loadAppConfigEffect(relayId, appId).pipe(
      Effect.map((app) =>
        app && movingAppImage(app.config) ? app.config.image : undefined
      )
    ),
  latestDeploymentStartedAt: (appId) =>
    latestAppDeploymentsEffect(appId).pipe(
      Effect.map(({ latest }) => latest?.startedAt ?? null)
    ),
  // Queued behind any deployment running, joining any deploy already asked
  // for; it deploys the update on offer when its turn comes.
  deployUpdate: (relay, appId, userId) =>
    askAppDeploymentEffect({
      appId,
      relayId: relay.id,
      trigger: "update",
      ...(userId !== null && { userId }),
    }).pipe(Effect.asVoid),
  published: publishAppDeploymentChange,
}

// A game server and a database take an update by deploying again, which
// pulls the tag their container was made from. That replaces the container,
// so it waits for everything else on the instance, in a turn of its own:
// whatever asks holds the instance already, and can't wait for it here.
const redeployForUpdate =
  (definition: {
    doing: string
    locks: (relayId: string, instanceId: string) => ReadonlyArray<LaneLock>
    name: string
    redeploy: (
      relay: PersistedRelay,
      instanceId: string,
      by: { trigger: "update"; userId: string | null }
    ) => Promise<unknown>
  }): UpdatedKind["deployUpdate"] =>
  (relay, instanceId, userId, digest) =>
    Effect.gen(function* () {
      // Kiln's own update deploys each image once, however that went.
      if (userId === null) {
        if (
          digest === null ||
          !(yield* claimImageUpdateEffect(
            instanceId,
            digest,
            crypto.randomUUID()
          ))
        ) {
          return
        }
      }
      outsideOperation(() =>
        forkAppWorker(
          inLanes(
            definition.name,
            definition.doing,
            definition.locks(relay.id, instanceId),
            promiseEffect(() =>
              definition.redeploy(relay, instanceId, {
                trigger: "update",
                userId,
              })
            )
          ).pipe(
            Effect.asVoid,
            // Its deployment's record and log say how it went.
            Effect.catchCause((cause) =>
              logException(Cause.squash(cause), {
                operation: "Instances.updates.deploy",
                attributes: {
                  "instance.id": instanceId,
                  "relay.id": relay.id,
                },
              })
            )
          )
        )
      )
    })

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
  deployUpdate: redeployForUpdate({
    doing: "Updating this database",
    locks: (relayId, databaseId) => [
      exclusive(resourceKey("database", relayId, databaseId)),
    ],
    name: "database.deploy",
    redeploy: async (relay, databaseId, by) => {
      const { redeployDatabase } =
        await import("@/server/instance-deploy.server")
      return redeployDatabase(relay, databaseId, by)
    },
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
  deployUpdate: redeployForUpdate({
    doing: "Updating this game server",
    // Its domains name its address, as for any deploy of one.
    locks: (relayId, instanceId) => [
      exclusive(resourceKey("instance", relayId, instanceId)),
      exclusive(
        dnsKey({ relayId, resourceId: instanceId, resourceType: "instance" })
      ),
    ],
    name: "instance.deploy",
    redeploy: async (relay, instanceId, by) => {
      const { redeployServer } = await import("@/server/instance-deploy.server")
      return redeployServer(relay, instanceId, by)
    },
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
