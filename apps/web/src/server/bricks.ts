import { createServerFn } from "@tanstack/react-start"
import {
  type Brick,
  type BrickRecipe,
  brickIdExceedsRecommendedLength,
  brickSchema,
  brickSourceSchema,
  relayCreateInstanceSchema,
  relayInstanceNameSchema,
  relayInstanceSchema,
  relayIdSchema,
  relayNetworkingSchema,
  relaySnapshotSchema,
  relayUpdateInstanceStartupSchema,
  resolveResourceLimits,
  resourceLimitsEqual,
} from "@workspace/contracts"
import { z } from "zod"

import {
  hasPlatformPermission,
  isPlatformAdmin,
  listUserGrants,
  requireRelayPermission,
} from "@/lib/access-control"
import {
  instanceScope,
  resolveScopeAuthorization,
} from "@/lib/scope-authorization.server"
import { grantHasPermission } from "@/lib/permissions"
import type { AccessGrant } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { hydrateBrickIcon } from "@/lib/brick-catalog-source.server"
import {
  listCustomBricksEffect,
  saveCustomBrickEffect,
} from "@/effect/custom-bricks"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { listMcJarVersionsEffect } from "@/effect/mcjarfiles"
import { provisionServer } from "@/lib/server-provisioning.server"
import { runAppEffect } from "@/effect/runtime"
import {
  invalidateRelayCache,
  relayCachePolicy,
  writeRelayCache,
} from "@/lib/relay-client"
import { requireEligibleResourceUser } from "@/server/auth"
import { visibleBrickCatalogs } from "@/server/brick-catalogs.server"
import {
  getInstanceStartupHandler,
  loadInstanceRecipe,
  requestRelay,
  requiredRelay,
} from "@/server/bricks.server"
import { provisionInstanceDomainBestEffort } from "@/server/domains.server"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayResourceLimitsRequest } from "@/lib/resource-limits.server"
import {
  startupPowerPermission,
  startupResourceLimitsChanged,
  startupConfigurationChanged,
} from "@/lib/startup-permissions"
export {
  startupPowerPermission,
  startupResourceLimitsChanged,
  startupConfigurationChanged,
} from "@/lib/startup-permissions"

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
    const { idempotencyKey, limits, relayId: _, ...createInput } = data
    const input = relayCreateInstanceSchema.parse({
      ...createInput,
      ...relayResourceLimitsRequest(
        relay.id,
        {
          cpuMillis: null,
          diskBytes: createInput.diskLimitBytes,
          memoryBytes: null,
        },
        limits
      ),
      recipeDefinition,
    })
    return provisionServer({
      create: input,
      idempotencyKey,
      ownerId: user.id,
      relay,
      requestedBy: user.id,
    })
  })

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
  .handler(async ({ data }) =>
    getInstanceStartupHandler(await requireEligibleResourceUser(), data)
  )

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
    // Startup weighs read, configuration, limits, network, and power authority.
    // Resolve the grants once and answer every check from the local set.
    const authorization = await resolveScopeAuthorization({
      scope: instanceScope(relay.id, data.instanceId),
      user,
    })
    authorization.require("instance.configuration.read")
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
    const requestedLimits =
      data.limits ??
      (data.diskLimitBytes === undefined
        ? undefined
        : { diskBytes: data.diskLimitBytes })
    let limitsChanged =
      !data.reinstall &&
      !resourceLimitsEqual(
        resolveResourceLimits(existing.limits, requestedLimits),
        existing.limits
      )
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
    if (networkChanged) authorization.require("instance.network.write")
    if (configurationChanged)
      authorization.require("instance.configuration.write")
    if (limitsChanged) authorization.require("instance.limits.write")
    // Applying unchanged settings still rebuilds the container. A read grant
    // alone must never authorize this mutation.
    if (
      !configurationChanged &&
      !limitsChanged &&
      !networkChanged &&
      !authorization.allows("instance.configuration.write") &&
      !authorization.allows("instance.limits.write")
    ) {
      authorization.require("instance.network.write")
    }
    const powerPermission = startupPowerPermission(existing, data)
    if (powerPermission) authorization.require(powerPermission)
    const {
      diskLimitBytes: _diskLimitBytes,
      limits: _limits,
      recipeDefinition: _untrustedRecipeDefinition,
      ...trustedData
    } = data
    const input = relayUpdateInstanceStartupSchema.parse({
      ...trustedData,
      ...(data.reinstall
        ? {}
        : relayResourceLimitsRequest(
            relay.id,
            existing.limits,
            requestedLimits
          )),
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
