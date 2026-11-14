import {
  type BrickRecipe,
  projectRelayInstanceOverview,
  relayControlDeadlineMs,
  relayInstanceSchema,
  relayManagedDatabaseSchema,
  relayUpdateInstanceStartupSchema,
} from "@workspace/contracts"
import type { z } from "zod"

import { setManagedDatabaseImageEffect } from "@/effect/managed-databases"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { serverDeployDnsLocks } from "@/lib/dns-operations"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  asDatabaseDeployment,
  asServerDeployment,
} from "@/lib/server-deployments.server"
import {
  loadInstanceRecipe,
  requestRelay,
  requiredRelay,
  requiredRelayInstance,
} from "@/server/bricks.server"
import { provisionInstanceDomainBestEffort } from "@/server/addresses.server"
import {
  databaseRpc,
  publishDatabaseChange,
} from "@/server/managed-database-access"
import { resourceOperation } from "@/server/resource-operation.server"

type RelayInstance = z.infer<typeof relayInstanceSchema>

/**
 * What follows a game server's container being replaced: its domains,
 * which name its address, and everyone's view of it.
 */
export async function instanceReplaced(
  relay: PersistedRelay,
  instance: RelayInstance
): Promise<RelayInstance> {
  await provisionInstanceDomainBestEffort(instance, relay.id)
  await runAppEffect(
    "relay.snapshot.invalidate",
    invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
  )
  publishRealtimeChange({
    instance,
    relayId: relay.id,
    type: "instance.upsert",
  })
  return instance
}

/**
 * Deploys a game server again as it is set up. Whoever may deploy it
 * needn't be able to read its configuration, so it answers with what a
 * game server's overview shows, never its startup answers or its Brick's
 * source.
 */
export async function redeployInstanceHandler(
  user: AuthenticatedUser,
  data: { instanceId: string; relayId: string }
) {
  const relay = await requiredRelay(data.relayId)
  await requireRelayPermission({
    instanceId: data.instanceId,
    permission: "instance.deploy",
    relayId: relay.id,
    user,
  })
  const instance = await redeployServer(relay, data.instanceId, {
    trigger: "reinstall",
    userId: user.id,
  })
  return { ...projectRelayInstanceOverview(instance), relayId: relay.id }
}

/**
 * Deploys a game server again as it is set up, for someone or, taking an
 * update on its own, for Kiln. Whoever calls holds the server whole and
 * has checked that they may.
 */
export async function redeployServer(
  relay: PersistedRelay,
  instanceId: string,
  by: { trigger: "reinstall" | "update"; userId: string | null }
): Promise<RelayInstance> {
  const existing = await requiredRelayInstance(relay, instanceId)
  return instanceReplaced(
    relay,
    relayInstanceSchema.parse(
      await asServerDeployment(
        {
          ...(await currentBrick(relay, existing)),
          instanceId,
          relayId: relay.id,
          trigger: by.trigger,
          userId: by.userId,
        },
        (deploymentId) =>
          requestRelay(
            relay,
            `/v1/instances/${encodeURIComponent(instanceId)}/deployments`,
            { method: "POST", body: JSON.stringify({ deploymentId }) },
            360_000,
            by.userId ?? undefined
          )
      )
    )
  )
}

/**
 * Installs the newer revision of a game server's Brick: the recipe its
 * catalog has now, at the same source, with the answers it already has.
 * The Relay refuses a recipe those answers no longer fit, as one with a new
 * question that has no default, and changes nothing. Whoever calls holds
 * the server whole and has checked that they may.
 */
export async function installServerBrickRevision(
  relay: PersistedRelay,
  instanceId: string,
  /** The revision to install, and where its catalog reads it from now. */
  newest: { definition: BrickRecipe; source: string },
  by: { userId: string | null }
): Promise<RelayInstance> {
  const existing = await requiredRelayInstance(relay, instanceId)
  const { definition: recipeDefinition, source } = newest
  return instanceReplaced(
    relay,
    relayInstanceSchema.parse(
      await asServerDeployment(
        {
          brickId: recipeDefinition.metadata.id,
          brickName: recipeDefinition.metadata.name,
          instanceId,
          relayId: relay.id,
          trigger: "update",
          userId: by.userId,
        },
        (deploymentId) =>
          requestRelay(
            relay,
            `/v1/instances/${encodeURIComponent(instanceId)}/startup`,
            {
              method: "PUT",
              body: JSON.stringify(
                relayUpdateInstanceStartupSchema.parse({
                  deploymentId,
                  recipe: source,
                  recipeDefinition,
                  // Left as it was: running again if it was running.
                  start:
                    existing.observedState === "running" ||
                    existing.observedState === "starting",
                  variables: existing.variables ?? {},
                })
              ),
            },
            360_000,
            by.userId ?? undefined
          )
      )
    )
  )
}

/**
 * Deploys a database again as it is: its image pulled anew and its
 * container replaced over the same data. Whoever calls holds the database
 * whole and has checked that they may.
 */
export async function redeployDatabase(
  relay: PersistedRelay,
  databaseId: string,
  by: { trigger: "redeploy" | "update"; userId: string | null },
  /** A newer revision of its Brick to install with the deploy. */
  brick?: { recipe: string; recipeDefinition: BrickRecipe }
) {
  const database = relayManagedDatabaseSchema.parse(
    await asDatabaseDeployment(
      { databaseId, relayId: relay.id, ...by },
      (deploymentId) =>
        databaseRpc(
          relay,
          "instance.deploy",
          { deploymentId, id: databaseId, kind: "database", ...brick },
          relayControlDeadlineMs("instance.deploy"),
          by.userId ?? undefined
        )
    )
  )
  // A newer recipe may run another image.
  if (brick) {
    await runAppEffect(
      "managedDatabases.record.image",
      setManagedDatabaseImageEffect(relay.id, databaseId, database.image)
    )
  }
  publishDatabaseChange(relay.id, false)
  return database
}

/**
 * Installs the newer revision of a database's Brick: the recipe its catalog
 * has now at `source`, with the answers the database already has. Its login
 * and its data stay as they are; the Relay refuses a recipe that would
 * change either, and changes nothing. Whoever calls holds the database
 * whole and has checked that they may.
 */
export async function installDatabaseBrickRevision(
  relay: PersistedRelay,
  databaseId: string,
  /** The revision to install, and where its catalog reads it from now. */
  newest: { definition: BrickRecipe; source: string },
  by: { userId: string | null }
) {
  return redeployDatabase(
    relay,
    databaseId,
    { trigger: "update", userId: by.userId },
    // Where the catalog reads it from now, which may be another commit.
    { recipe: newest.source, recipeDefinition: newest.definition }
  )
}

// Its image pulled anew and its container replaced, with nothing about it
// changed. It replaces the server, so everything else on it waits, and it
// provisions its domains afterwards.
export const deployInstanceAgain = resourceOperation({
  kind: "instance",
  id: (input: { instanceId: string; relayId: string }) => input.instanceId,
  name: "instance.deploy",
  lock: "whole",
  alsoLocks: (input) => serverDeployDnsLocks(input.relayId, input.instanceId),
  doing: "Deploying this game server again",
  permission: () => "instance.deploy",
  run: redeployInstanceHandler,
})

// The Brick a deploy installs again, as its deployment names it.
async function currentBrick(relay: PersistedRelay, instance: RelayInstance) {
  const brick = await recoverPromise(
    async () => (await loadInstanceRecipe(relay, instance)).brick.metadata,
    () => null
  )
  return {
    brickId: brick?.id ?? instance.brickId ?? null,
    brickName: brick?.name ?? null,
  }
}
