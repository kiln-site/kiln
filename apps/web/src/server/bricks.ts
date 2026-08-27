import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import {
  type Brick,
  type BrickRecipe,
  brickIdExceedsRecommendedLength,
  brickSchema,
  brickSourceSchema,
  brickVariableValuesSchema,
  relayCreateInstanceSchema,
  relayInstanceNameSchema,
  relayInstanceSchema,
  relayIdSchema,
  relayNetworkingSchema,
  relaySnapshotSchema,
  relayUpdateInstanceStartupSchema,
  relayDiskAllocationAvailableBytes,
} from "@workspace/contracts"
import { z } from "zod"

import {
  hasPlatformPermission,
  isPlatformAdmin,
  isRelayCreator,
  requireRelayPermission,
} from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { hydrateBrickVariables } from "@/lib/brick-variables"
import { hydrateBrickIcon } from "@/lib/brick-catalog-source.server"
import {
  listCustomBricksEffect,
  saveCustomBrickEffect,
} from "@/effect/custom-bricks"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { listMcJarVersionsEffect } from "@/effect/mcjarfiles"
import { promiseEffect } from "@/effect/promise"
import { forkAppEffect, runAppEffect } from "@/effect/runtime"
import {
  registerPreparedInstance,
  reservePreparedInstance,
  unregisterInstance,
} from "@/lib/instance-registry"
import {
  invalidateRelayCache,
  relayCachePolicy,
  relayJsonEffect,
  writeRelayCache,
} from "@/lib/relay-client"
import { requireAuthenticatedUser } from "@/server/auth"
import { visibleBrickCatalogs } from "@/server/brick-catalogs.server"
import { provisionInstanceDomainBestEffort } from "@/server/domains.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

const brickVersionCatalogSchema = z.object({
  type: z.string().regex(/^[a-z0-9-]+$/u),
  variant: z.string().regex(/^[a-z0-9-]+$/u),
})

const relayInputSchema = z.object({ relayId: relayIdSchema })
export const hearthCreateInstanceInputSchema = relayCreateInstanceSchema
  .omit({ recipeDefinition: true })
  .extend({
    ...relayInputSchema.shape,
    idempotencyKey: z.uuid(),
    name: relayInstanceNameSchema,
  })
  .strict()
const networkingInputSchema = relayNetworkingSchema.extend(
  relayInputSchema.shape
)
const recipeInputSchema = relayInputSchema.extend({ source: brickSourceSchema })
const instanceInputSchema = relayInputSchema.extend({
  instanceId: z.string().regex(/^[a-f0-9]{40}$/u),
})
const cancelProvisioningResultSchema = z.object({
  cancelled: z.boolean(),
  instanceId: instanceInputSchema.shape.instanceId,
})
export const hearthUpdateInstanceStartupInputSchema =
  relayUpdateInstanceStartupSchema
    .extend(instanceInputSchema.shape)
    .strict()
    .superRefine((value, context) => {
      if (value.recipeDefinition !== undefined) {
        context.addIssue({
          code: "custom",
          message: "Brick definitions are resolved by Hearth",
          path: ["recipeDefinition"],
        })
      }
    })

export const getBrickCatalog = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireAuthenticatedUser()
    const canAddCustomBrick = hasPlatformPermission(
      user,
      "platform.bricks.add-custom"
    )
    const customBricksPromise = canAddCustomBrick
      ? runAppEffect("customBricks.list", listCustomBricksEffect(user.id)).then(
          (bricks) =>
            Promise.all(bricks.map((brick) => hydrateBrickIcon(brick)))
        )
      : Promise.resolve([])
    const catalogsPromise = visibleBrickCatalogs(user)
    const candidates = (await listPersistedRelays()).filter(
      (relay) => relay.enabled && canProvisionOnRelay(user, relay)
    )
    const snapshots = await Promise.allSettled(
      candidates.map((relay) => requestRelay(relay, "/v1/snapshot"))
    )
    const relays = candidates.filter((_, index) => {
      const snapshot = snapshots[index]
      return (
        snapshot?.status === "fulfilled" &&
        relaySnapshotSchema.safeParse(snapshot.value).data?.node
          .canProvisionInstances === true
      )
    })
    const catalogs = await catalogsPromise
    const sources = new Set<string>()
    const bricks = catalogs.flatMap((catalog) =>
      catalog.bricks.filter((brick) => {
        if (sources.has(brick.source)) return false
        sources.add(brick.source)
        return true
      })
    )
    return {
      relays,
      bricks,
      canAddCustomBrick,
      customBricks: await customBricksPromise,
    }
  }
)

export const getBrickIconPresentations = createServerFn({
  method: "GET",
}).handler(async () => {
  const user = await requireAuthenticatedUser()
  const canUseCustomBricks = hasPlatformPermission(
    user,
    "platform.bricks.add-custom"
  )
  const [catalogs, customBricks] = await Promise.all([
    visibleBrickCatalogs(user),
    canUseCustomBricks
      ? runAppEffect("customBricks.list", listCustomBricksEffect(user.id)).then(
          (bricks) =>
            Promise.all(bricks.map((brick) => hydrateBrickIcon(brick)))
        )
      : Promise.resolve([]),
  ])
  const sources = new Set<string>()
  const bricks = catalogs.flatMap((catalog) => catalog.bricks)
  bricks.push(...customBricks)
  const presentations = []
  for (const brick of bricks) {
    if (sources.has(brick.source)) continue
    sources.add(brick.source)
    presentations.push({
      id: brick.metadata.id,
      source: brick.source,
      ...(brick.metadata.color ? { color: brick.metadata.color } : {}),
      ...(brick.iconSvg ? { iconSvg: brick.iconSvg } : {}),
    })
  }
  return presentations
})

export const getBrickVersions = createServerFn({ method: "GET" })
  .validator(brickVersionCatalogSchema)
  .handler(async ({ data }) => {
    await requireAuthenticatedUser()
    return runAppEffect(
      "mcjarfiles.versions",
      listMcJarVersionsEffect(data.type, data.variant)
    )
  })

export const createBrickInstance = createServerFn({ method: "POST" })
  .validator(hearthCreateInstanceInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    requireRelayProvisionAccess(user, relay)
    const recipeDefinition = await requiredVisibleRecipeDefinition(
      user,
      data.recipe
    )
    const { idempotencyKey, relayId: _, ...createInput } = data
    const input = relayCreateInstanceSchema.parse({
      ...createInput,
      recipeDefinition,
    })
    const instanceId = provisioningInstanceId(idempotencyKey)
    const cancel = () =>
      requestRelay(
        relay,
        `/v1/instances/${encodeURIComponent(instanceId)}/provision`,
        { method: "DELETE" },
        30_000,
        user.id
      ).then((result) => cancelProvisioningResultSchema.parse(result).cancelled)
    const unregister = () => unregisterInstance(relay.id, instanceId)
    await reservePreparedInstance(relay.id, { id: instanceId }, user.id)
    const instance = await Effect.runPromise(
      promiseEffect(() =>
        requestRelay(
          relay,
          "/v1/instance-provisioning",
          {
            method: "POST",
            body: JSON.stringify({ ...input, idempotencyKey, instanceId }),
          },
          30_000,
          user.id
        )
      ).pipe(
        Effect.map(relayInstanceSchema.parse),
        Effect.tapError(() =>
          compensatePreparedProvisioning(cancel, unregister)
        )
      )
    )
    await Effect.runPromise(
      promiseEffect(() =>
        registerPreparedInstance(relay.id, instance, user.id)
      ).pipe(
        Effect.tapError(() =>
          compensatePreparedProvisioning(cancel, unregister)
        )
      )
    )
    await claimPreparedProvisioning({
      cancel,
      claim: () =>
        requestRelay(
          relay,
          `/v1/instances/${encodeURIComponent(instance.id)}/provision`,
          { method: "POST" },
          30_000,
          user.id
        ),
      unregister,
    })
    forkAppEffect(
      "relay.snapshot.invalidate",
      invalidateRelayCache(relayCachePolicy.snapshot(relay.id))
    )
    publishRealtimeChange({
      instance,
      relayId: relay.id,
      type: "instance.upsert",
    })
    return instance
  })

export function compensatePreparedProvisioning(
  cancel: () => Promise<boolean>,
  unregister: () => Promise<void>
) {
  return promiseEffect(cancel).pipe(
    Effect.flatMap((cancelled) =>
      cancelled ? promiseEffect(unregister) : Effect.void
    ),
    Effect.catch(() => Effect.void)
  )
}

export function provisioningInstanceId(idempotencyKey: string): string {
  const hex = idempotencyKey.replaceAll("-", "")
  return `${hex}${hex.slice(0, 8)}`
}

export function claimPreparedProvisioning(input: {
  cancel: () => Promise<boolean>
  claim: () => Promise<unknown>
  unregister: () => Promise<void>
}): Promise<void> {
  return Effect.runPromise(
    promiseEffect(input.claim).pipe(
      Effect.asVoid,
      Effect.matchEffect({
        onFailure: (claimFailure) =>
          promiseEffect(input.cancel).pipe(
            Effect.matchEffect({
              onFailure: () =>
                Effect.fail(
                  new Error(
                    `Kiln could not confirm whether Relay accepted provisioning. Retry the unchanged request to resume the same server. ${
                      claimFailure instanceof Error
                        ? claimFailure.message
                        : "Relay claim failed"
                    }`,
                    { cause: claimFailure }
                  )
                ),
              onSuccess: (cancelled) =>
                cancelled
                  ? promiseEffect(input.unregister).pipe(
                      Effect.catch(() => Effect.void),
                      Effect.andThen(Effect.fail(claimFailure))
                    )
                  : Effect.void,
            })
          ),
        onSuccess: () => Effect.void,
      })
    )
  )
}

export const getInstanceRecipe = createServerFn({ method: "GET" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.read",
      instanceId: data.instanceId,
    })
    const snapshot = relaySnapshotSchema.parse(
      await requestRelay(relay, "/v1/snapshot")
    )
    const instance = snapshot.instances.find(
      (candidate) => candidate.id === data.instanceId
    )
    if (!instance) throw new Error("Instance not found")
    const recipe = await loadInstanceRecipe(relay, instance)
    return {
      content: JSON.stringify(recipePreview(recipe.brick), null, 2),
      name: recipe.brick.metadata.name,
      sourceUrl: externalRecipeUrl(recipe.brickSource),
    }
  })

export const getInstanceStartup = createServerFn({ method: "GET" })
  .validator(instanceInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.settings",
      instanceId: data.instanceId,
    })
    const snapshot = relaySnapshotSchema.parse(
      await requestRelay(relay, "/v1/snapshot")
    )
    const instance = snapshot.instances.find(
      (candidate) => candidate.id === data.instanceId
    )
    if (!instance) throw new Error("Instance not found")
    const { brick, brickSource } = await loadInstanceRecipe(relay, instance)
    const variables = hydrateBrickVariables(brick, instance.variables)
    const otherInstances = snapshot.instances.filter(
      (candidate) => candidate.id !== instance.id
    )
    const otherMemoryBytes = otherInstances.reduce(
      (total, candidate) => total + candidate.limits.memoryBytes,
      0
    )
    const otherDiskBytes = otherInstances.reduce(
      (total, candidate) => total + candidate.limits.diskBytes,
      0
    )
    return {
      allocation: {
        memory: {
          availableBytes: Math.max(
            snapshot.node.memory.totalBytes - otherMemoryBytes,
            instance.limits.memoryBytes
          ),
          nodeTotalBytes: snapshot.node.memory.totalBytes,
          nodeUsedBytes: snapshot.node.memory.usedBytes,
        },
        storage: {
          availableBytes: relayDiskAllocationAvailableBytes(
            snapshot.node.storage.totalBytes,
            otherDiskBytes,
            instance.limits.diskBytes
          ),
          nodeTotalBytes: snapshot.node.storage.totalBytes,
          nodeUsedBytes: snapshot.node.storage.usedBytes,
        },
      },
      brick,
      brickSource,
      instance: relayInstanceSchema.parse(instance),
      variables: brickVariableValuesSchema.parse(variables),
    }
  })

export const updateInstanceStartup = createServerFn({ method: "POST" })
  .validator(hearthUpdateInstanceStartupInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.settings",
      instanceId: data.instanceId,
    })
    const existing = await requiredRelayInstance(relay, data.instanceId)
    const submittedRecipe = data.recipe
    const recipeDefinition = isBrickSourceChange(
      existing.brickSource,
      submittedRecipe
    )
      ? await requiredVisibleRecipeDefinition(user, submittedRecipe)
      : null
    const { recipeDefinition: _untrustedRecipeDefinition, ...trustedData } =
      data
    const input = relayUpdateInstanceStartupSchema.parse({
      ...trustedData,
      ...(recipeDefinition ? { recipeDefinition } : {}),
    })
    const instance = relayInstanceSchema.parse(
      await requestRelay(
        relay,
        `/v1/instances/${encodeURIComponent(data.instanceId)}/startup`,
        {
          method: "PUT",
          body: JSON.stringify(input),
        },
        360_000,
        user.id
      )
    )
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
  })

async function loadInstanceRecipe(
  relay: PersistedRelay,
  instance: z.infer<typeof relayInstanceSchema>
) {
  let brickSource = instance.brickSource
  if (!brickSource) {
    throw new Error("This server has no Brick recipe")
  }
  const brick = await hydrateBrickIcon(
    brickSchema.parse(
      await requestRelay(
        relay,
        `/v1/bricks/recipe?source=${encodeURIComponent(brickSource)}${
          instance.brickSnapshotSha256
            ? `&snapshotSha256=${encodeURIComponent(instance.brickSnapshotSha256)}`
            : ""
        }`
      )
    )
  )
  return { brick, brickSource }
}

function recipePreview(brick: z.infer<typeof brickSchema>) {
  const { iconSvg: _iconSvg, ...recipe } = brick
  return {
    ...recipe,
    variables: Object.fromEntries(
      Object.entries(brick.variables).map(([name, variable]) => [
        name,
        variable.sensitive
          ? {
              ...variable,
              ...(variable.default === undefined
                ? {}
                : { default: "[redacted]" }),
              ...(variable.options === undefined
                ? {}
                : { options: variable.options.map(() => "[redacted]") }),
            }
          : variable,
      ])
    ),
  }
}

function externalRecipeUrl(source: string) {
  const protocol = new URL(source).protocol
  return protocol === "http:" || protocol === "https:" ? source : null
}

export const loadBrickRecipe = createServerFn({ method: "POST" })
  .validator(recipeInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    requireBrickSourcePermission(user, "platform.bricks.add-custom")
    const relay = await requiredRelay(data.relayId)
    requireRelayProvisionAccess(user, relay)
    const { brick } = parseImportedBrickFromRelay(
      await requestRelay(
        relay,
        `/v1/bricks/recipe?source=${encodeURIComponent(data.source)}`
      )
    )
    return hydrateBrickIcon(brick)
  })

export const saveCustomBrick = createServerFn({ method: "POST" })
  .validator(recipeInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    requireBrickSourcePermission(user, "platform.bricks.add-custom")
    const relay = await requiredRelay(data.relayId)
    requireRelayProvisionAccess(user, relay)

    const imported = await requestRelay(
      relay,
      `/v1/bricks/recipe?source=${encodeURIComponent(data.source)}`
    )
    const { brick: parsedBrick, brickIdExceedsRecommendation } =
      parseImportedBrickFromRelay(imported)
    const brick = await hydrateBrickIcon(parsedBrick)
    const saved = await runAppEffect(
      "customBricks.save",
      saveCustomBrickEffect(user.id, brick)
    )
    return { brick: saved, brickIdExceedsRecommendation }
  })

export function parseImportedBrickFromRelay(value: unknown): {
  brick: Brick
  brickIdExceedsRecommendation: boolean
} {
  const brick = brickSchema.parse(value)
  return {
    brick,
    brickIdExceedsRecommendation: brickIdExceedsRecommendedLength(
      brick.metadata.id
    ),
  }
}

export const configureBrickNetworking = createServerFn({ method: "POST" })
  .validator(networkingInputSchema)
  .handler(async ({ data }) => {
    const user = await requireAuthenticatedUser()
    const relay = await requiredRelay(data.relayId)
    requireRelayProvisionAccess(user, relay)
    const input = relayNetworkingSchema.parse(data)
    const networking = relayNetworkingSchema.parse(
      await requestRelay(
        relay,
        "/v1/networking",
        {
          method: "PUT",
          body: JSON.stringify(input),
        },
        240_000,
        user.id
      )
    )
    await runAppEffect(
      "relay.networking.cache",
      writeRelayCache(relayCachePolicy.networking(relay.id), networking)
    )
    return networking
  })

async function requiredRelay(id: string): Promise<PersistedRelay> {
  const relay = (await listPersistedRelays()).find(
    (item) => item.enabled && item.id === id
  )
  if (!relay) throw new Error("Relay not found")
  return relay
}

function canProvisionOnRelay(
  user: AuthenticatedUser,
  relay: PersistedRelay
): boolean {
  return (
    isPlatformAdmin(user) ||
    (isRelayCreator(user) && relay.createdBy === user.id)
  )
}

function requireRelayProvisionAccess(
  user: AuthenticatedUser,
  relay: PersistedRelay
): void {
  if (!canProvisionOnRelay(user, relay)) {
    throw new Error("You can only provision on Relays you created")
  }
}

function requireBrickSourcePermission(
  user: AuthenticatedUser,
  permission: "platform.bricks.add-custom"
): void {
  if (!hasPlatformPermission(user, permission)) {
    throw new Error("This action requires Bring your own Relay access")
  }
}

export function isBrickSourceChange(
  existingSource: string | null | undefined,
  submittedSource: string | undefined
): submittedSource is string {
  return submittedSource !== undefined && submittedSource !== existingSource
}

async function requiredVisibleRecipeDefinition(
  user: AuthenticatedUser,
  source: string
) {
  const definition = await visibleRecipeDefinition(user, source)
  if (!definition) {
    throw new Error("This Brick is not available in your catalogs")
  }
  return definition
}

export function brickRecipeDefinition(brick: Brick): BrickRecipe {
  const { iconSvg: _iconSvg, source: _source, ...definition } = brick
  return definition
}

async function visibleRecipeDefinition(
  user: AuthenticatedUser,
  source: string
) {
  const canUseCustomBricks = hasPlatformPermission(
    user,
    "platform.bricks.add-custom"
  )
  const [catalogs, customBricks] = await Promise.all([
    visibleBrickCatalogs(user),
    canUseCustomBricks
      ? runAppEffect("customBricks.list", listCustomBricksEffect(user.id))
      : Promise.resolve([]),
  ])
  const brick = [
    ...catalogs.flatMap((catalog) => catalog.bricks),
    ...customBricks,
  ].find((candidate) => candidate.source === source)
  if (!brick) return null
  return brickRecipeDefinition(brick)
}

async function requiredRelayInstance(
  relay: PersistedRelay,
  instanceId: string
) {
  const snapshot = relaySnapshotSchema.parse(
    await requestRelay(relay, "/v1/snapshot")
  )
  const instance = snapshot.instances.find(
    (candidate) => candidate.id === instanceId
  )
  if (!instance) throw new Error("Instance not found")
  return instance
}

async function requestRelay(
  relay: PersistedRelay,
  path: string,
  init?: RequestInit,
  timeout = 15_000,
  subject?: string
): Promise<unknown> {
  return runAppEffect(
    "relay.json",
    relayJsonEffect(relay, path, (input) => input, init, timeout, subject)
  )
}
