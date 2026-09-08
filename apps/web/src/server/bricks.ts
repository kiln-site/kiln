import { createServerFn } from "@tanstack/react-start"
import { Effect } from "effect"
import {
  type Brick,
  type BrickRecipe,
  type BrickVariableValue,
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
  hasRelayPermission,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import { grantHasPermission } from "@/lib/permissions"
import type { AccessGrant } from "@/lib/access-control"
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
import { requireEligibleResourceUser } from "@/server/auth"
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
    const user = await requireEligibleResourceUser()
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
    const grants = isPlatformAdmin(user) ? [] : await listUserGrants(user.id)
    const candidates = (await listPersistedRelays()).filter(
      (relay) => relay.enabled && canProvisionOnRelay(user, relay, grants)
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
  const user = await requireEligibleResourceUser()
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
    await requireEligibleResourceUser()
    return runAppEffect(
      "mcjarfiles.versions",
      listMcJarVersionsEffect(data.type, data.variant)
    )
  })

export const createBrickInstance = createServerFn({ method: "POST" })
  .validator(hearthCreateInstanceInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayProvisionAccess(user, relay)
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
      directoryChanged: true,
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
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.configuration.read",
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
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.configuration.read",
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

export function startupPowerPermission(
  existing: Pick<
    z.infer<typeof relayInstanceSchema>,
    "desiredState" | "observedState"
  >,
  input: { start: boolean; reinstall?: boolean }
):
  | "instance.power.start"
  | "instance.power.stop"
  | "instance.power.restart"
  | null {
  const running =
    existing.desiredState === "running" ||
    ["running", "starting", "stopping"].includes(existing.observedState)
  const start = input.reinstall
    ? existing.desiredState === "running"
    : input.start
  return running
    ? start
      ? "instance.power.restart"
      : "instance.power.stop"
    : start
      ? "instance.power.start"
      : null
}

// Include defaults and every variable referenced by resource templates. Omitted
// variables and Brick swaps must not bypass the independent limits permission.
export function startupResourceLimitsChanged(
  previous: BrickRecipe,
  next: BrickRecipe,
  previousVariables: Readonly<Record<string, BrickVariableValue>>,
  nextVariables: Readonly<Record<string, BrickVariableValue>>
): boolean {
  const signature = (
    recipe: BrickRecipe,
    variables: Readonly<Record<string, BrickVariableValue>>
  ) => {
    const resources = recipe.runtime.resources
    const referenced = [
      ...new Set(
        Array.from(
          JSON.stringify(resources).matchAll(
            /variables\.([a-z][a-z0-9_]{0,47})/gu
          ),
          (match) => match[1]
        )
      ),
    ].sort()
    return JSON.stringify([
      resources,
      referenced.map((key) => [
        key,
        Object.hasOwn(variables, key)
          ? variables[key]
          : recipe.variables[key]?.default,
      ]),
    ])
  }
  return (
    signature(previous, previousVariables) !== signature(next, nextVariables)
  )
}

export function startupConfigurationChanged(
  previous: BrickRecipe,
  next: BrickRecipe,
  previousVariables: Readonly<Record<string, BrickVariableValue>>,
  nextVariables: Readonly<Record<string, BrickVariableValue>>
): boolean {
  const resourceVariables = new Set(
    Array.from(
      JSON.stringify([
        previous.runtime.resources,
        next.runtime.resources,
      ]).matchAll(/variables\.([a-z][a-z0-9_]{0,47})/gu),
      (match) => match[1]
    )
  )
  const keys = new Set([
    ...Object.keys(previous.variables),
    ...Object.keys(next.variables),
    ...Object.keys(previousVariables),
    ...Object.keys(nextVariables),
  ])
  for (const key of keys) {
    if (resourceVariables.has(key)) continue
    const before = Object.hasOwn(previousVariables, key)
      ? previousVariables[key]
      : previous.variables[key]?.default
    const after = Object.hasOwn(nextVariables, key)
      ? nextVariables[key]
      : next.variables[key]?.default
    if (!Object.is(before, after)) return true
  }
  return false
}

export function startupNetworkChanged(
  existing: z.infer<typeof relayInstanceSchema>["tailscale"],
  input: {
    reinstall?: boolean
    tailscale?: z.infer<typeof relayInstanceSchema>["tailscale"]
  }
): boolean {
  // Reinstall preserves the applied network configuration. Compare fields,
  // not JSON order, so a repeated settings object remains a no-op.
  return (
    !input.reinstall &&
    input.tailscale !== undefined &&
    (input.tailscale.enabled !== existing.enabled ||
      input.tailscale.subdomain !== existing.subdomain)
  )
}

export const updateInstanceStartup = createServerFn({ method: "POST" })
  .validator(hearthUpdateInstanceStartupInputSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "instance.configuration.read",
      instanceId: data.instanceId,
    })
    const existing = await requiredRelayInstance(relay, data.instanceId)
    const submittedRecipe = data.recipe
    const recipeChanged =
      !data.reinstall &&
      isBrickSourceChange(existing.brickSource, submittedRecipe)
    const recipeDefinition = recipeChanged
      ? await requiredVisibleRecipeDefinition(user, submittedRecipe)
      : null
    const networkChanged = startupNetworkChanged(existing.tailscale, data)
    let configurationChanged = Boolean(data.reinstall || recipeChanged)
    let limitsChanged =
      !data.reinstall &&
      data.diskLimitBytes !== undefined &&
      data.diskLimitBytes !== existing.limits.diskBytes
    if (!data.reinstall) {
      const { brick: previousRecipe } = await loadInstanceRecipe(
        relay,
        existing
      )
      const nextRecipe = recipeDefinition ?? previousRecipe
      configurationChanged ||= startupConfigurationChanged(
        previousRecipe,
        nextRecipe,
        existing.variables ?? {},
        data.variables ?? {}
      )
      limitsChanged ||= startupResourceLimitsChanged(
        previousRecipe,
        nextRecipe,
        existing.variables ?? {},
        data.variables ?? {}
      )
    }
    const permissionInput = {
      user,
      relayId: relay.id,
      instanceId: data.instanceId,
    }
    if (networkChanged)
      await requireRelayPermission({
        ...permissionInput,
        permission: "instance.network.write",
      })
    if (configurationChanged)
      await requireRelayPermission({
        ...permissionInput,
        permission: "instance.configuration.write",
      })
    if (limitsChanged)
      await requireRelayPermission({
        ...permissionInput,
        permission: "instance.limits.write",
      })
    // Applying unchanged settings still rebuilds the container. A read grant
    // alone must never authorize this mutation.
    if (!configurationChanged && !limitsChanged && !networkChanged) {
      const canConfigure = await hasRelayPermission({
        ...permissionInput,
        permission: "instance.configuration.write",
      })
      const canChangeLimits =
        !canConfigure &&
        (await hasRelayPermission({
          ...permissionInput,
          permission: "instance.limits.write",
        }))
      await requireRelayPermission({
        ...permissionInput,
        permission: canConfigure
          ? "instance.configuration.write"
          : canChangeLimits
            ? "instance.limits.write"
            : "instance.network.write",
      })
    }
    const powerPermission = startupPowerPermission(existing, data)
    if (powerPermission)
      await requireRelayPermission({
        ...permissionInput,
        permission: powerPermission,
      })
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
    const user = await requireEligibleResourceUser()
    requireBrickSourcePermission(user, "platform.bricks.add-custom")
    const relay = await requiredRelay(data.relayId)
    await requireRelayProvisionAccess(user, relay)
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
    const user = await requireEligibleResourceUser()
    requireBrickSourcePermission(user, "platform.bricks.add-custom")
    const relay = await requiredRelay(data.relayId)
    await requireRelayProvisionAccess(user, relay)

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
    const user = await requireEligibleResourceUser()
    const relay = await requiredRelay(data.relayId)
    await requireRelayPermission({
      user,
      relayId: relay.id,
      permission: "relay.configure",
    })
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
  relay: PersistedRelay,
  grants: readonly AccessGrant[]
): boolean {
  return (
    isPlatformAdmin(user) ||
    grants.some(
      (grant) =>
        grant.relayId === relay.id &&
        grant.resourceType === "relay" &&
        grantHasPermission(grant, "instance.create")
    )
  )
}

async function requireRelayProvisionAccess(
  user: AuthenticatedUser,
  relay: PersistedRelay
): Promise<void> {
  await requireRelayPermission({
    user,
    relayId: relay.id,
    permission: "instance.create",
  })
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
