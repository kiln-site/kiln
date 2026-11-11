import { Effect } from "effect"

import { latestAppDeploymentsEffect } from "@/effect/app-deployments"
import type { Database } from "@/effect/database"
import type { InstanceUpdateKind } from "@/effect/instance-updates"
import {
  listRelayAppConfigsEffect,
  loadAppConfigEffect,
} from "@/effect/managed-apps"
import {
  askAppDeploymentEffect,
  publishAppDeploymentChange,
} from "@/lib/app-deployments.server"
import type { PersistedRelay } from "@/lib/relay-registry"

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
  /** Asks for the update on offer to be deployed, by someone or by Kiln. */
  deployUpdate: (
    relay: PersistedRelay,
    instanceId: string,
    userId: string | null
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

/** Every kind that takes updates. */
export const updatedKinds: ReadonlyArray<UpdatedKind> = [apps]

export function updatedKind(kind: InstanceUpdateKind): UpdatedKind {
  const found = updatedKinds.find((candidate) => candidate.kind === kind)
  if (!found) throw new Error(`${kind} doesn't take updates yet`)
  return found
}
