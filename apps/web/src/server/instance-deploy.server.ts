import {
  projectRelayInstanceOverview,
  relayControlDeadlineMs,
  relayInstanceSchema,
  relayManagedDatabaseSchema,
} from "@workspace/contracts"
import type { z } from "zod"

import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { dnsKey } from "@/lib/dns-operations"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import type { PersistedRelay } from "@/lib/relay-registry"
import {
  asDatabaseDeployment,
  asServerDeployment,
} from "@/lib/server-deployments.server"
import { exclusive } from "@/operations/lanes"
import {
  loadInstanceRecipe,
  requestRelay,
  requiredRelay,
  requiredRelayInstance,
} from "@/server/bricks.server"
import { provisionInstanceDomainBestEffort } from "@/server/domains.server"
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
 * Deploys a database again as it is: its image pulled anew and its
 * container replaced over the same data. Whoever calls holds the database
 * whole and has checked that they may.
 */
export async function redeployDatabase(
  relay: PersistedRelay,
  databaseId: string,
  by: { trigger: "redeploy" | "update"; userId: string | null }
) {
  const database = relayManagedDatabaseSchema.parse(
    await asDatabaseDeployment(
      { databaseId, relayId: relay.id, ...by },
      (deploymentId) =>
        databaseRpc(
          relay,
          "instance.deploy",
          { deploymentId, id: databaseId, kind: "database" },
          relayControlDeadlineMs("instance.deploy"),
          by.userId ?? undefined
        )
    )
  )
  publishDatabaseChange(relay.id, false)
  return database
}

/** The locks a game server's deploy takes besides the server itself. */
export const serverDeployLocks = (relayId: string, instanceId: string) => [
  exclusive(
    dnsKey({ relayId, resourceId: instanceId, resourceType: "instance" })
  ),
]

// Its image pulled anew and its container replaced, with nothing about it
// changed. It replaces the server, so everything else on it waits, and it
// provisions its domains afterwards.
export const deployInstanceAgain = resourceOperation({
  kind: "instance",
  id: (input: { instanceId: string; relayId: string }) => input.instanceId,
  name: "instance.deploy",
  lock: "whole",
  alsoLocks: (input) => serverDeployLocks(input.relayId, input.instanceId),
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
