import { createHash } from "node:crypto"

import {
  appTailscaleMember,
  brickSourceSchema,
  databaseTailscaleMember,
  instanceTailscaleMember,
  MAXIMUM_TUNNEL_BINDINGS,
  permissionRelayReach,
  relayIdSchema,
  relayInstanceNameSchema,
  relaySnapshotSchema,
  relayTailscaleDomainSchema,
  tunnelIdSchema,
  tunnelSchema,
  tunnelsSchema,
  relayTailscaleSubdomainSchema,
  tailscaleMemberIdSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  observeGatewaysEffect,
  reconcileGatewaysEffect,
  requestTunnelCleanupEffect,
} from "@/effect/tunnel-gateways"
import {
  createTailscaleNodeAuthKeyEffect,
  inspectTailscaleControlPlaneEffect,
  removeTailscaleControlPlaneDeviceEffect,
  syncTailscaleControlPlaneEffect,
  verifyTailscaleOAuthCredentialEffect,
} from "@/effect/tailscale-api"
import {
  createTunnelDefinitionEffect,
  loadTunnelCredentialEffect,
  loadTunnelDefinitionsEffect,
  recordTunnelSyncEffect,
  saveTunnelIntegrationEffect,
  tunnelRelaysEffect,
  saveTunnelDefinitionEffect,
  type TailscaleIntegration,
  type TunnelDefinition,
  type TailscaleOAuthCredential,
} from "@/effect/tunnels"
import { reserveInstanceId } from "@/effect/instance-ids"
import { tunnelDomainConflictEffect } from "@/effect/domains"
import { recoverPromise } from "@/effect/promise"
import {
  addTunnelAliasEffect,
  generateTunnelNamesEffect,
  keepTunnelNamesOfEffect,
  listTunnelNamesEffect,
  loadTunnelNameEffect,
  removeTunnelAliasEffect,
  setGeneratedTunnelNamesEffect,
  type TunnelName,
} from "@/effect/tunnel-names"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { setPrimaryAddressEffect } from "@/effect/primary-addresses"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, requireRelayPermission } from "@/lib/access-control"
import { accessPermissions, type AccessPermission } from "@/lib/permissions"
import { requireTunnelManager } from "@/server/tunnel-access.server"
import {
  officialTunnelBrickSource,
  requiredTunnelBrick,
} from "@/server/tunnel-bricks.server"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import { relayRpc } from "@/lib/relay-connection"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { startTunnelDeletion } from "@/lib/tunnel-deletion.server"
import { writeTunnelDns } from "@/lib/tunnel-dns.server"
import { tailscaleMemberProblem } from "@/lib/tailscale-members"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { tunnelKey, tunnelSettingsKey } from "@/lib/tunnel-lanes"
import { exclusive } from "@/operations/lanes"
import { invalidateManagedDomainAddressesEffect } from "@/server/addresses.server"
import { operation, signedIn } from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  applyGatewayPlanEffect,
  type DesiredGateway,
  type GatewayOperations,
} from "@/server/tunnel-orchestration"
import type { RelaySnapshot, Tunnel as Gateway } from "@workspace/contracts"

const stackBindingInputSchema = z.strictObject({
  enabled: z.boolean().default(true),
  // Renames its generated name. One connecting without it is named from
  // what it's called (`generateTunnelNamesEffect`); one connected keeps its.
  label: relayTailscaleSubdomainSchema.optional(),
  // A game server or an App's service (see `tailscaleMemberIdSchema`).
  memberId: tailscaleMemberIdSchema,
  relayId: relayIdSchema,
})

const tailscaleClientSecretSchema = z.string().trim().min(20).max(512)

export const saveTunnelSchema = z.strictObject({
  bindings: z.array(stackBindingInputSchema).max(MAXIMUM_TUNNEL_BINDINGS),
  // Its TLDs, in order: the first is the one generated names are under.
  domains: z
    .array(relayTailscaleDomainSchema)
    .min(1)
    .max(16)
    .refine(
      (domains) => new Set(domains).size === domains.length,
      "List each TLD once"
    ),
  id: tunnelIdSchema,
  name: relayInstanceNameSchema,
})

export const createTunnelSchema = z.strictObject({
  // The Brick its gateways run: one of Kiln's own tunnel Bricks.
  brick: brickSourceSchema,
  clientId: z.string().trim().min(1).max(120),
  clientSecret: tailscaleClientSecretSchema,
  domains: z
    .array(relayTailscaleDomainSchema)
    .min(1)
    .max(16)
    .refine(
      (domains) => new Set(domains).size === domains.length,
      "List each TLD once"
    ),
  name: relayInstanceNameSchema,
  tag: z
    .string()
    .trim()
    .transform((value) => (value.startsWith("tag:") ? value : `tag:${value}`))
    .pipe(z.string().regex(/^tag:[a-zA-Z0-9][a-zA-Z0-9-]*$/u)),
})

export const removeTunnelSchema = z.strictObject({
  id: tunnelIdSchema,
})

export const configureTailscaleIntegrationSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(120),
  clientSecret: tailscaleClientSecretSchema.optional(),
  domains: z
    .array(relayTailscaleDomainSchema)
    .min(1)
    .max(16)
    .refine(
      (domains) => new Set(domains).size === domains.length,
      "List each TLD once"
    ),
  id: tunnelIdSchema,
  // The TLDs it had, which stop pointing at it.
  previousDomains: z.array(relayTailscaleDomainSchema).max(16),
  tag: z
    .string()
    .trim()
    .transform((value) => (value.startsWith("tag:") ? value : `tag:${value}`))
    .pipe(z.string().regex(/^tag:[a-zA-Z0-9][a-zA-Z0-9-]*$/u)),
})

export const previewTailscaleIntegrationSchema =
  configureTailscaleIntegrationSchema
    .omit({ previousDomains: true })
    .extend({ clientSecret: tailscaleClientSecretSchema })

export const syncTailscaleIntegrationSchema = z.strictObject({
  id: tunnelIdSchema,
})

export interface GatewayOverview extends Gateway {
  relayId: string
  relayName: string
}

/** One of a connected member's names in its tunnel. */
export type TunnelMemberName = Omit<TunnelName, "tunnelId">

export interface TunnelOverview {
  /**
   * What the viewer may do: change the tunnel and connect to it, and on
   * each gateway, by its ID, what every kind of instance has.
   */
  access: {
    manage: boolean
    gateways: Record<string, ReadonlyArray<AccessPermission>>
  }
  /** Everything it connects, each through the gateway on its Relay. */
  bindings: Array<{
    address: string
    enabled: boolean
    /** Its generated name's label, under the tunnel's first TLD. */
    label: string
    memberId: string
    relayId: string
    relayName: string
  }>
  /** The Brick its gateways run, by source; none for Kiln's `tailscale`. */
  brickSource: string | null
  cleanup: TunnelDefinition["cleanup"]
  domains: Array<string>
  /** Its part on each Relay something it connects is on. */
  gateways: Array<GatewayOverview>
  id: string
  integration: TailscaleIntegration | null
  name: string
  /** Every name of everything it connects, generated ones first. */
  names: Array<TunnelMemberName>
  ownerId: string | null
}

export interface TunnelsResult {
  tunnels: Array<TunnelOverview>
  unavailableRelays: Array<{
    id: string
    message: string
    name: string
  }>
}

// Reading it, and what every kind of instance has, as its pages check them.
export const gatewayPermissions: ReadonlyArray<AccessPermission> = [
  "instance.read",
  ...accessPermissions.filter(
    (permission) => permissionRelayReach(permission).length > 0
  ),
]

export const createTunnelOperation = operation<
  z.infer<typeof createTunnelSchema> & { id: string }
>()({
  name: "tunnel.create",
  doing: "Creating this tunnel",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelKey(input.id))],
  run: ({ context: user, input }) =>
    promiseEffect(() => createTunnelHandler(user, input)),
  audit: ({ input }) => ({ id: input.id, kind: "tunnel" }),
})

async function createTunnelHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof createTunnelSchema> & { id: string }
) {
  const definitions = await loadTunnelDefinitions()
  await requireUnusedDomains(definitions, data.id, data.domains)
  // Checked now, so a tunnel never names a Brick it can't run.
  await requiredTunnelBrick(data.brick)
  const verified = await runAppEffect(
    "tailscale.oauth.verify",
    verifyTailscaleOAuthCredentialEffect(data.clientId, data.clientSecret, [
      data.tag,
    ])
  )
  await runAppEffect(
    "tunnel.create",
    createTunnelDefinitionEffect(
      {
        brickSource: data.brick,
        domains: data.domains,
        id: data.id,
        name: data.name,
      },
      verified,
      data.clientSecret,
      user.id
    )
  )
  publishTailscaleChange()
  return loadTunnels()
}

export const configureTailscaleIntegrationOperation = operation<
  z.infer<typeof configureTailscaleIntegrationSchema>
>()({
  name: "tunnel.connect",
  doing: "Connecting this network to Tailscale",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelSettingsKey(input.id))],
  run: ({ input }) =>
    promiseEffect(() => configureTailscaleIntegrationHandler(input)),
  audit: ({ input }) => ({ id: input.id, kind: "tunnel" }),
})

async function configureTailscaleIntegrationHandler(
  data: z.infer<typeof configureTailscaleIntegrationSchema>
) {
  const definitions = await loadTunnelDefinitions()
  const definition = definitions.find(({ id }) => id === data.id)
  if (!definition) throw new Error("Tunnel not found")
  // Its removal still needs the credentials it was set up with.
  if (definition.cleanup) {
    throw new Error("This tunnel is being removed")
  }
  const clientSecret =
    data.clientSecret ?? (await loadTunnelCredential(data.id)).clientSecret
  const verified = await runAppEffect(
    "tailscale.oauth.verify",
    verifyTailscaleOAuthCredentialEffect(data.clientId, clientSecret, [
      data.tag,
    ])
  )
  await runAppEffect(
    "tunnel.integration.save",
    saveTunnelIntegrationEffect(data.id, verified, clientSecret)
  )
  const credential = {
    ...verified,
    clientSecret,
  } satisfies TailscaleOAuthCredential
  const configured = await Effect.runPromise(
    promiseEffect(async () => {
      const result = await loadTunnels()
      requireCompleteGatewayList(result.unavailableRelays)
      const stack = result.tunnels.find(({ id }) => id === data.id)
      if (!stack) throw new Error("Tunnel not found")
      if (stack.domains.join(" ") !== data.domains.join(" ")) {
        throw new Error("The tunnel's TLDs changed before setup completed")
      }
      await synchronizeTailscaleControlPlane(credential, {
        ...stack,
        previousDomains: data.previousDomains,
      })
      const inspection = await inspectTailscaleControlPlane(
        credential,
        stack,
        data.previousDomains
      )
      return {
        inspection,
        result: await loadTunnels(),
      }
    }).pipe(Effect.tapError(recordTailscaleSyncFailure(data.id)))
  )
  publishTailscaleChange()
  return configured
}

export const syncTailscaleIntegrationOperation = operation<
  z.infer<typeof syncTailscaleIntegrationSchema>
>()({
  name: "tunnel.sync",
  doing: "Syncing this tunnel with Tailscale",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelSettingsKey(input.id))],
  run: ({ input }) =>
    promiseEffect(() => syncTailscaleIntegrationHandler(input)),
  audit: ({ input }) => ({ id: input.id, kind: "tunnel" }),
})

async function syncTailscaleIntegrationHandler(
  data: z.infer<typeof syncTailscaleIntegrationSchema>
) {
  const [credential, result] = await Promise.all([
    loadTunnelCredential(data.id),
    loadTunnels(),
  ])
  requireCompleteGatewayList(result.unavailableRelays)
  const stack = result.tunnels.find(({ id }) => id === data.id)
  if (!stack) throw new Error("Tunnel not found")
  // Its removal takes its nodes away; a sync would point DNS back at them.
  if (stack.cleanup) throw new Error("This tunnel is being removed")
  const synchronized = await Effect.runPromise(
    promiseEffect(async () => {
      await synchronizeTailscaleControlPlane(credential, stack)
      return loadTunnels()
    }).pipe(Effect.tapError(recordTailscaleSyncFailure(data.id)))
  )
  publishTailscaleChange()
  return synchronized
}

export const saveTunnelOperation = operation<
  z.infer<typeof saveTunnelSchema>
>()({
  name: "tunnel.save",
  doing: "Saving this tunnel",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelSettingsKey(input.id))],
  run: ({ context: user, input }) =>
    promiseEffect(() => saveTunnelHandler(user.id, input)),
  audit: ({ input }) => ({ id: input.id, kind: "tunnel" }),
})

export const tunnelConnectionSchema = z.strictObject({
  // Connecting, or disconnecting.
  connected: z.boolean(),
  // Renames its generated name as it connects; left out, one connecting is
  // named from what it's called, and one connected keeps its name.
  label: relayTailscaleSubdomainSchema.optional(),
  // A game server, an App's service or a database (`tailscaleMemberIdSchema`).
  memberId: tailscaleMemberIdSchema,
  // The Relay it runs on, where its gateway is or is made.
  relayId: relayIdSchema,
  tunnelId: tunnelIdSchema,
})

export const connectTunnelOperation = operation<
  z.infer<typeof tunnelConnectionSchema>
>()({
  name: "tunnel.connect",
  doing: "Connecting it to this tunnel",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.tap((person) =>
        promiseEffect(() => requireTunnelConnection(person, input))
      )
    ),
  locks: ({ input }) => [exclusive(tunnelSettingsKey(input.tunnelId))],
  run: ({ context: user, input }) =>
    promiseEffect(() => connectTunnelHandler(user, input)),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

// What changing a member's connections takes of the member itself, as a
// database connection does (`database-connections.server.ts`).
async function requireTunnelConnection(
  user: AuthenticatedUser,
  input: z.infer<typeof tunnelConnectionSchema>
) {
  await requireTunnelManager(user, input.tunnelId)
  const app = appTailscaleMember(input.memberId)
  const databaseId = databaseTailscaleMember(input.memberId)
  const instanceId = instanceTailscaleMember(input.memberId)
  await requireRelayPermission({
    ...(app
      ? { appId: app.appId, permission: "app.manage" }
      : databaseId
        ? { databaseId, permission: "database.network.write" }
        : {
            instanceId: instanceId ?? "",
            permission: "instance.network.write",
          }),
    relayId: input.relayId,
    user,
  })
}

async function connectTunnelHandler(
  user: AuthenticatedUser,
  input: z.infer<typeof tunnelConnectionSchema>
) {
  const tunnel = (await loadTunnels()).tunnels.find(
    ({ id }) => id === input.tunnelId
  )
  if (!tunnel) throw new Error("Tunnel not found")
  const others = tunnel.bindings
    .filter(({ memberId }) => memberId !== input.memberId)
    .map(({ enabled, memberId, relayId }) => ({ enabled, memberId, relayId }))
  return saveTunnelHandler(user.id, {
    bindings: input.connected
      ? [
          ...others,
          {
            enabled: true,
            memberId: input.memberId,
            relayId: input.relayId,
            ...(input.label === undefined ? {} : { label: input.label }),
          },
        ]
      : others,
    domains: tunnel.domains,
    id: tunnel.id,
    name: tunnel.name,
  })
}

async function saveTunnelHandler(
  subject: string,
  data: z.infer<typeof saveTunnelSchema>
) {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const relayById = new Map(relays.map((relay) => [relay.id, relay]))
  const id = data.id
  const firstDomain = data.domains[0]!
  const duplicateMember = data.bindings.find(
    (binding, index, bindings) =>
      bindings.findIndex(
        (candidate) => candidate.memberId === binding.memberId
      ) !== index
  )
  if (duplicateMember) {
    throw new Error("Something connects to a tunnel through one tunnel")
  }
  const names = await runAppEffect(
    "tunnelNames.list",
    listTunnelNamesEffect([id])
  )

  const [currentResult, definitions] = await Promise.all([
    loadGateways(relays),
    loadTunnelDefinitions(),
  ])
  const current = currentResult.gateways
  const currentForStack = current.filter((gateway) => gateway.tailnetId === id)
  const definition = definitions.find((candidate) => candidate.id === id)
  if (!definition) throw new Error("Tunnel not found")

  // Its gateways follow what it connects: a Relay something connects on has
  // one, made as the first thing there connects, and one with nothing left
  // to connect goes, as its last member leaves or is deleted.
  const grouped = new Map<string, typeof data.bindings>()
  for (const binding of data.bindings) {
    const relayBindings = grouped.get(binding.relayId) ?? []
    relayBindings.push(binding)
    grouped.set(binding.relayId, relayBindings)
  }
  for (const relayId of grouped.keys()) {
    if (!relayById.has(relayId)) {
      throw new Error(
        "A Relay this tunnel would have a gateway on is unavailable"
      )
    }
  }
  if (definition.cleanup) {
    throw new Error("This tunnel is being removed")
  }
  const currentRelayIds = new Set(currentForStack.map(({ relayId }) => relayId))
  await requireUnusedDomains(definitions, id, data.domains)
  requireCompleteGatewayList(currentResult.unavailableRelays)
  const [appRecords, databaseRecords] = await Promise.all([
    data.bindings.some((binding) => appTailscaleMember(binding.memberId))
      ? runAppEffect("tailscale.appMembers", listAppRecordsEffect())
      : [],
    data.bindings.some((binding) => databaseTailscaleMember(binding.memberId))
      ? runAppEffect(
          "tailscale.databaseMembers",
          listManagedDatabaseRecordsEffect()
        )
      : [],
  ])
  for (const binding of data.bindings) {
    const snapshot = currentResult.snapshots.get(binding.relayId)
    if (!snapshot) {
      throw new Error(
        "A Relay this tunnel would have a gateway on is unavailable"
      )
    }
    const problem = tailscaleMemberProblem(binding, {
      apps: appRecords,
      databases: databaseRecords,
      instances: snapshot.instances,
    })
    if (problem) throw new Error(problem)
  }
  // Each member's generated name: as renamed, as it was, or, connecting,
  // made from what it's called.
  const kept = new Map(
    names
      .filter((name) => name.generated)
      .map((name) => [name.memberId, name.label])
  )
  const appNames = new Map(appRecords.map((app) => [app.appId, app.name]))
  const databaseNames = new Map(
    databaseRecords.map((database) => [database.databaseId, database.name])
  )
  const unnamed = data.bindings.flatMap((binding) => {
    if (binding.label !== undefined || kept.has(binding.memberId)) return []
    const app = appTailscaleMember(binding.memberId)
    if (app) {
      return [
        {
          fallback: `app-${app.appId.slice(0, 6)}`,
          memberId: binding.memberId,
          // An image or Dockerfile App's one service is `app`; a Compose
          // App's are named, and each is called after it.
          name: [
            appNames.get(app.appId) ?? "",
            app.service === "app" ? "" : app.service,
          ].join(" "),
        },
      ]
    }
    const databaseId = databaseTailscaleMember(binding.memberId)
    if (databaseId) {
      return [
        {
          fallback: `database-${databaseId.slice(0, 6)}`,
          memberId: binding.memberId,
          name: databaseNames.get(databaseId) ?? "",
        },
      ]
    }
    const instanceId = instanceTailscaleMember(binding.memberId) ?? ""
    return [
      {
        fallback: `game-server-${instanceId.slice(0, 6)}`,
        memberId: binding.memberId,
        name:
          currentResult.snapshots
            .get(binding.relayId)
            ?.instances.find((instance) => instance.id === instanceId)?.name ??
          "",
      },
    ]
  })
  const generated = await runAppEffect(
    "tunnelNames.generate",
    generateTunnelNamesEffect(
      id,
      firstDomain,
      unnamed,
      data.bindings.flatMap(({ label }) => (label === undefined ? [] : [label]))
    )
  )
  const labelOf = (memberId: string, label: string | undefined) =>
    label ?? kept.get(memberId) ?? generated.get(memberId)!
  // A name is unique in its tunnel, so each member's generated name under
  // the first TLD is checked before anything changes: no two members take
  // the same one, and none takes a name another member that stays has now,
  // even one that member is renamed from in the same save, as names change
  // one at a time. One of its own aliases becomes its generated name.
  const bound = new Set(data.bindings.map(({ memberId }) => memberId))
  const chosen = new Set<string>()
  for (const binding of data.bindings) {
    const label = labelOf(binding.memberId, binding.label)
    if (chosen.has(label)) {
      throw new Error(`${label}.${firstDomain} is chosen more than once`)
    }
    chosen.add(label)
    const taken = names.find(
      (name) =>
        name.memberId !== binding.memberId &&
        bound.has(name.memberId) &&
        name.label === label &&
        name.domain === firstDomain
    )
    if (taken) {
      throw new Error(
        `${label}.${firstDomain} is already another member's name`
      )
    }
  }

  const nextDefinition: TunnelDefinition = {
    ...definition,
    domains: data.domains,
    name: data.name,
  }
  // A Relay the tunnel has a gateway on keeps it; one it doesn't gets a
  // new gateway, with an ID of its own.
  const gatewayOn = new Map(
    currentForStack.map((gateway) => [gateway.relayId, gateway.id])
  )
  const desired = await Promise.all(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([relayId, bindings]): Promise<DesiredGateway> => {
        const relay = relayById.get(relayId)
        if (!relay) {
          throw new Error(
            "A Relay this tunnel would have a gateway on is unavailable"
          )
        }
        return {
          bindings: bindings.map(({ enabled, memberId }) => ({
            enabled,
            memberId,
          })),
          hostname: gatewayHostname(data.name, relay.name, relay.id),
          id: gatewayOn.get(relayId) ?? (await reserveInstanceId("gateway")),
          relayId,
          relayName: relay.name,
        }
      })
  )
  const integrationCredential = definition?.integration
    ? await loadTunnelCredential(id)
    : null
  const newTargets = desired.filter(
    ({ relayId }) => !currentRelayIds.has(relayId)
  )
  // A new gateway logs in with a key Kiln makes with the tunnel's login.
  if (newTargets.length > 0 && !integrationCredential) {
    throw new Error(
      `Add a Tailscale login to ${definition.name} before connecting something on a Relay it has no gateway on`
    )
  }
  // A new gateway runs the tunnel's Brick, one of Kiln's own.
  const brick =
    newTargets.length > 0
      ? await requiredTunnelBrick(
          definition.brickSource ?? (await officialTunnelBrickSource())
        )
      : undefined
  const desiredRelayIds = new Set(grouped.keys())
  const removed = currentForStack.filter(
    ({ relayId }) => !desiredRelayIds.has(relayId)
  )
  const reservedSubnets = new Set<string>()
  for (const gateway of current) {
    if (gateway.tailnetId !== id) reservedSubnets.add(gateway.subnet)
  }
  const synchronized = await runAppEffect(
    "tailscale.gateway.save",
    applyGatewayPlanEffect({
      brick,
      authKeyForTarget: integrationCredential
        ? async (target) =>
            createTailscaleNodeAuthKey(integrationCredential, target.hostname)
        : undefined,
      current: currentForStack,
      desired,
      domains: data.domains,
      id,
      name: data.name,
      operations: gatewayOperations(
        // Where it's going and where it was, for DNS after a rollback too.
        { id, relayIds: [...desiredRelayIds, ...currentRelayIds] },
        relayById,
        subject,
        integrationCredential
          ? (gateway) =>
              removeTailscaleControlPlaneDevice(integrationCredential, gateway)
          : undefined
      ),
      reservedSubnets,
      beforeFinalize: async (gateways) => {
        if (integrationCredential && definition?.integration) {
          const integration = definition.integration
          await Effect.runPromise(
            promiseEffect(() =>
              synchronizeTailscaleControlPlane(
                integrationCredential,
                tailscaleOverviewForGateways(
                  nextDefinition,
                  gateways,
                  definition.domains
                )
              )
            ).pipe(
              Effect.tap(() =>
                Effect.sync(() => {
                  nextDefinition.integration = {
                    ...integration,
                    lastError: null,
                    lastSyncedAt: new Date().toISOString(),
                  }
                })
              ),
              Effect.catch((cause) =>
                promiseEffect(() =>
                  recordTailscaleSync(id, errorMessage(cause))
                ).pipe(
                  Effect.andThen(
                    promiseEffect(() =>
                      restoreTailscaleControlPlane(
                        integrationCredential,
                        definition,
                        currentForStack
                      )
                    )
                  ),
                  Effect.andThen(Effect.fail(cause))
                )
              )
            )
          )
        }
        await Effect.runPromise(
          promiseEffect(() =>
            saveTunnelDefinition(nextDefinition, subject)
          ).pipe(
            Effect.catch((cause) =>
              Effect.gen(function* () {
                const domainOwnerAfterConflict = yield* Effect.gen(
                  function* () {
                    if (integrationCredential && definition) {
                      yield* promiseEffect(() =>
                        restoreTailscaleControlPlane(
                          integrationCredential,
                          definition,
                          currentForStack
                        )
                      )
                    }
                    return integrationCredential &&
                      definition?.domains.join(" ") !==
                        nextDefinition.domains.join(" ")
                      ? yield* promiseEffect(() =>
                          reconcileTailscaleDomainAfterDefinitionFailure(
                            integrationCredential,
                            nextDefinition,
                            relays
                          )
                        )
                      : null
                  }
                ).pipe(
                  Effect.mapError(
                    (recoveryCause) =>
                      new Error(
                        `${errorMessage(cause)}. Tailscale DNS recovery also failed: ${errorMessage(recoveryCause)}`,
                        { cause: recoveryCause }
                      )
                  )
                )
                if (domainOwnerAfterConflict) {
                  return yield* Effect.fail(
                    new Error(
                      `A TLD of this tunnel is already used by ${domainOwnerAfterConflict.name}`,
                      { cause }
                    )
                  )
                }
                return yield* Effect.fail(cause)
              })
            )
          )
        )
      },
    })
  )

  const affectedRelayIds = [
    ...desiredRelayIds,
    ...removed.map(({ relayId }) => relayId),
  ]
  await invalidateRelaySnapshots(affectedRelayIds)
  await runAppEffect(
    "tailscale.cleanup.gateways.reconcile",
    reconcileGatewaysEffect(
      id,
      synchronized,
      removed.map(({ relayId }) => relayId)
    )
  )
  // Its members' names, now its gateways have them: each connected one's
  // generated name under its first TLD, as chosen, and no name of a member
  // that left or under a TLD it no longer has. Its DNS then serves them.
  await runAppEffect(
    "tunnelNames.save",
    Effect.gen(function* () {
      const members = data.bindings.map(({ memberId }) => memberId)
      // The names of members that left go first, so none is in the way of
      // a name that moves; names under a TLD it no longer has go last, once
      // generated ones moved off it, keeping their IDs and primaries.
      yield* keepTunnelNamesOfEffect(id, members, [
        ...new Set([...data.domains, ...definition.domains]),
      ])
      yield* setGeneratedTunnelNamesEffect(
        id,
        data.bindings.map(({ label, memberId }) => ({
          domain: firstDomain,
          label: labelOf(memberId, label),
          memberId,
        }))
      )
      yield* keepTunnelNamesOfEffect(id, members, data.domains)
    })
  )
  await writeTunnelDns({ id, relayIds: [...desiredRelayIds] }, subject)
  publishTailscaleChange()
  return {
    tunnels: groupGateways(
      [
        ...current.filter((gateway) => gateway.tailnetId !== id),
        ...synchronized,
      ],
      replaceTunnelDefinition(definitions, nextDefinition),
      await runAppEffect(
        "tunnelNames.list",
        listTunnelNamesEffect(
          replaceTunnelDefinition(definitions, nextDefinition).map(
            (definition) => definition.id
          )
        )
      )
    ),
    unavailableRelays: currentResult.unavailableRelays,
  }
}

/**
 * The tunnels with a gateway that connects nothing, as one does once the
 * last thing on its Relay is deleted.
 */
export async function tunnelsWithEmptyGateways(): Promise<Array<string>> {
  const { tunnels } = await loadTunnels()
  return tunnels
    .filter(
      (tunnel) =>
        !tunnel.cleanup &&
        tunnel.gateways.some(
          (gateway) =>
            !tunnel.bindings.some(({ relayId }) => relayId === gateway.relayId)
        )
    )
    .map(({ id }) => id)
}

/**
 * Saves a tunnel as it is, which takes away each gateway that connects
 * nothing. Run it holding the tunnel's `#settings`.
 */
export async function pruneEmptyGateways(tunnelId: string, subject: string) {
  const tunnel = (await loadTunnels()).tunnels.find(({ id }) => id === tunnelId)
  if (!tunnel || tunnel.cleanup) return
  const empty = tunnel.gateways.some(
    (gateway) =>
      !tunnel.bindings.some(({ relayId }) => relayId === gateway.relayId)
  )
  if (!empty) return
  await saveTunnelHandler(subject, {
    bindings: tunnel.bindings.map(({ enabled, memberId, relayId }) => ({
      enabled,
      memberId,
      relayId,
    })),
    domains: tunnel.domains,
    id: tunnel.id,
    name: tunnel.name,
  })
}

export const tunnelAliasSchema = z.strictObject({
  domain: relayTailscaleDomainSchema,
  label: relayTailscaleSubdomainSchema,
  memberId: tailscaleMemberIdSchema,
  tunnelId: tunnelIdSchema,
})

export const addTunnelAliasOperation = operation<
  z.infer<typeof tunnelAliasSchema>
>()({
  name: "tunnel.alias.add",
  doing: "Giving this member another name",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelSettingsKey(input.tunnelId))],
  run: ({ context: user, input }) =>
    promiseEffect(() => addTunnelAliasHandler(user, input)),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

async function addTunnelAliasHandler(
  user: AuthenticatedUser,
  input: z.infer<typeof tunnelAliasSchema>
) {
  const definition = (await loadTunnelDefinitions()).find(
    ({ id }) => id === input.tunnelId
  )
  if (!definition) throw new Error("Tunnel not found")
  if (!definition.domains.includes(input.domain)) {
    throw new Error(`.${input.domain} isn't one of this tunnel's TLDs`)
  }
  const names = await runAppEffect(
    "tunnelNames.list",
    listTunnelNamesEffect([input.tunnelId])
  )
  if (
    !names.some((name) => name.generated && name.memberId === input.memberId)
  ) {
    throw new Error("Connect it to this tunnel before giving it a name")
  }
  const existing = names.find(
    (name) => name.label === input.label && name.domain === input.domain
  )
  // The same alias again is a retry of one whose DNS failed: only that
  // runs again.
  if (
    existing &&
    (existing.generated || existing.memberId !== input.memberId)
  ) {
    throw new Error(`${input.label}.${input.domain} is already a name here`)
  }
  if (existing) {
    await rewriteTunnelNames(input.tunnelId, user.id)
    return loadTunnels()
  }
  const id = await runAppEffect(
    "tunnelNames.addAlias",
    addTunnelAliasEffect(input)
  )
  await serveNamesOrUndo(input.tunnelId, user.id, () =>
    runAppEffect("tunnelNames.removeAlias", removeTunnelAliasEffect(id))
  )
  return loadTunnels()
}

/**
 * Serves a tunnel's names after one changed. If its gateways can't all take
 * them, the change is undone and what they serve put back, so the name
 * stays as it was and asking again tries again.
 */
async function serveNamesOrUndo(
  tunnelId: string,
  subject: string,
  undo: () => Promise<unknown>
) {
  const failure = await recoverPromise(
    async () => {
      await rewriteTunnelNames(tunnelId, subject)
      return null
    },
    (cause) => ({ cause })
  )
  if (!failure) return
  await undo()
  // Gateways that took the change before another failed take it back; one
  // that still can't is told again by the next change.
  await recoverPromise(
    () => rewriteTunnelNames(tunnelId, subject),
    () => undefined
  )
  throw failure.cause
}

export const removeTunnelAliasSchema = z.strictObject({ id: z.uuid() })

export const removeTunnelAliasOperation = operation<
  z.infer<typeof removeTunnelAliasSchema> & { tunnelId: string }
>()({
  name: "tunnel.alias.remove",
  doing: "Taking away this name",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelSettingsKey(input.tunnelId))],
  run: ({ context: user, input }) =>
    promiseEffect(async () => {
      const name = await runAppEffect(
        "tunnelNames.load",
        loadTunnelNameEffect(input.id)
      )
      if (!name || name.tunnelId !== input.tunnelId) {
        throw new Error("That name is gone")
      }
      const removed = await runAppEffect(
        "tunnelNames.removeAlias",
        removeTunnelAliasEffect(input.id)
      )
      if (!removed)
        throw new Error("A generated name can be renamed, not removed")
      await serveNamesOrUndo(input.tunnelId, user.id, () =>
        runAppEffect("tunnelNames.addAlias", addTunnelAliasEffect(name))
      )
      return loadTunnels()
    }),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

export const primaryTunnelNameSchema = z.strictObject({ id: z.uuid() })

export const setPrimaryTunnelNameOperation = operation<
  z.infer<typeof primaryTunnelNameSchema> & { tunnelId: string }
>()({
  name: "tunnel.name.primary",
  doing: "Making this name its primary address",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelSettingsKey(input.tunnelId))],
  run: ({ input }) =>
    promiseEffect(() => setPrimaryTunnelNameHandler(input.id)),
  audit: ({ input }) => ({ id: input.tunnelId, kind: "tunnel" }),
})

async function setPrimaryTunnelNameHandler(id: string) {
  const name = await runAppEffect("tunnelNames.load", loadTunnelNameEffect(id))
  if (!name) throw new Error("That name is gone")
  const app = appTailscaleMember(name.memberId)
  const instanceId = instanceTailscaleMember(name.memberId)
  const instance = app
    ? ({ id: app.appId, type: "app" } as const)
    : instanceId
      ? ({ id: instanceId, type: "instance" } as const)
      : null
  if (!instance) throw new Error("A database has no primary address")
  await runAppEffect(
    "primaryAddresses.set",
    setPrimaryAddressEffect(instance, { kind: "tunnel", ref: name.id })
  )
  // A game server shows and advertises it.
  if (instance.type === "instance") {
    await runAppEffect(
      "domains.addresses.invalidate",
      invalidateManagedDomainAddressesEffect
    )
  }
  publishTailscaleChange()
  return loadTunnels()
}

// Serves a tunnel's names as they are now, on every gateway it has.
async function rewriteTunnelNames(tunnelId: string, subject: string) {
  const relays = await runAppEffect(
    "tunnels.relays",
    tunnelRelaysEffect([tunnelId])
  )
  await writeTunnelDns(
    { id: tunnelId, relayIds: relays.get(tunnelId) ?? [] },
    subject
  )
  // A game server whose primary was one of them shows another now.
  await runAppEffect(
    "domains.addresses.invalidate",
    invalidateManagedDomainAddressesEffect
  )
  publishTailscaleChange()
}

export const removeTunnelOperation = operation<
  z.infer<typeof removeTunnelSchema>
>()({
  name: "tunnel.remove",
  doing: "Removing this tunnel",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tunnelKey(input.id))],
  run: ({ context: user, input }) =>
    promiseEffect(() => removeTunnelHandler(user, input)),
  audit: ({ input }) => ({ id: input.id, kind: "tunnel" }),
})

async function removeTunnelHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof removeTunnelSchema>
) {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const [current, definitions] = await Promise.all([
    loadGateways(relays),
    loadTunnelDefinitions(),
  ])
  const gateways = current.gateways.filter(
    (gateway) => gateway.tailnetId === data.id
  )
  const definition = definitions.find(({ id }) => id === data.id)
  if (!definition) throw new Error("Tunnel not found")
  await runAppEffect(
    "tailscale.cleanup.request",
    requestTunnelCleanupEffect(data.id, user.id, gateways).pipe(
      Effect.andThen(startTunnelDeletion(data.id, user.id))
    )
  )
  publishTailscaleChange()
  return loadTunnels()
}

function publishTailscaleChange(): void {
  publishRealtimeChange({
    audience: { kind: "platform-admins" },
    topics: ["tailscale"],
    type: "hearth.invalidate",
  })
}

// For an operation's authorize: the signed-in platform administrator.
const tailscaleAdministrator = (user: AuthenticatedUser | null) =>
  signedIn(user).pipe(
    Effect.filterOrFail(
      isPlatformAdmin,
      () => new Error("Platform administrator access required")
    )
  )

export async function requireTailscaleAdministrator() {
  const user = await requireEligibleResourceUser()
  if (!isPlatformAdmin(user)) {
    throw new Error("Platform administrator access required")
  }
  return user
}

export async function loadTunnels(): Promise<TunnelsResult> {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const [definitions, result] = await Promise.all([
    loadTunnelDefinitions(),
    loadGateways(relays),
  ])
  const definitionIds = new Set(definitions.map(({ id }) => id))
  const observed = result.gateways.filter((gateway) =>
    definitionIds.has(gateway.tailnetId)
  )
  if (observed.length > 0) {
    await Effect.runPromise(
      promiseEffect(() =>
        runAppEffect(
          "tailscale.cleanup.gateways.observe",
          observeGatewaysEffect(observed)
        )
      ).pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.sync(() =>
            console.warn(
              "[Kiln] Could not persist observed Tailscale gateways:",
              cause
            )
          )
        )
      )
    )
  }
  return {
    tunnels: groupGateways(
      result.gateways,
      definitions,
      await runAppEffect(
        "tunnelNames.list",
        listTunnelNamesEffect(definitions.map(({ id }) => id))
      )
    ),
    unavailableRelays: result.unavailableRelays,
  }
}

function groupGateways(
  gateways: ReadonlyArray<GatewayOverview>,
  definitions: ReadonlyArray<TunnelDefinition>,
  names: ReadonlyArray<TunnelName>
): Array<TunnelOverview> {
  // Each member's generated name in each tunnel, by both.
  const generated = new Map(
    names
      .filter((name) => name.generated)
      .map((name) => [`${name.tunnelId}:${name.memberId}`, name.label])
  )
  const grouped = new Map<string, TunnelOverview>()
  const namesOf = (tunnelId: string) =>
    names.flatMap(({ tunnelId: of, ...name }) =>
      of === tunnelId ? [name] : []
    )
  for (const definition of definitions) {
    grouped.set(definition.id, {
      ...definition,
      access: { manage: true, gateways: {} },
      bindings: [],
      gateways: [],
      names: namesOf(definition.id),
    })
  }
  for (const gateway of gateways) {
    const stack = grouped.get(gateway.tailnetId) ?? {
      access: { manage: true, gateways: {} },
      bindings: [],
      brickSource: null,
      cleanup: null,
      gateways: [],
      domains: gateway.domains,
      id: gateway.tailnetId,
      integration: null,
      name: gateway.name,
      names: namesOf(gateway.tailnetId),
      ownerId: null,
    }
    stack.gateways.push(gateway)
    stack.access.gateways[gateway.id] = gatewayPermissions
    stack.bindings.push(
      ...gateway.bindings.map((binding) => ({
        ...binding,
        label: generated.get(`${gateway.tailnetId}:${binding.memberId}`) ?? "",
        relayId: gateway.relayId,
        relayName: gateway.relayName,
      }))
    )
    grouped.set(gateway.tailnetId, stack)
  }
  return [...grouped.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
}

async function loadGateways(relays: ReadonlyArray<PersistedRelay>): Promise<{
  gateways: Array<GatewayOverview>
  snapshots: Map<string, RelaySnapshot>
  unavailableRelays: TunnelsResult["unavailableRelays"]
}> {
  const results = await Effect.runPromise(
    Effect.forEach(
      relays,
      (relay) =>
        promiseEffect(async () => {
          const [snapshot, stacks] = await Promise.all([
            relayRpc(relay, "relay.snapshot", {}, 5_000).then((value) =>
              relaySnapshotSchema.parse(value)
            ),
            relayRpc(relay, "tunnel.list", {}, 5_000).then((value) =>
              tunnelsSchema.parse(value)
            ),
          ])
          return {
            gateways: stacks.map((stack) => ({
              ...stack,
              relayId: relay.id,
              relayName: relay.name,
            })),
            relayId: relay.id,
            snapshot,
            unavailableRelay: null,
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.succeed({
              gateways: [],
              relayId: relay.id,
              snapshot: null,
              unavailableRelay: {
                id: relay.id,
                message:
                  cause instanceof Error
                    ? cause.message
                    : "The Relay did not return its tunnels",
                name: relay.name,
              },
            })
          )
        ),
      { concurrency: "unbounded" }
    )
  )
  const snapshots = new Map<string, RelaySnapshot>()
  for (const result of results) {
    if (result.snapshot) snapshots.set(result.relayId, result.snapshot)
  }
  return {
    gateways: results.flatMap((result) => result.gateways),
    snapshots,
    unavailableRelays: results.flatMap((result) =>
      result.unavailableRelay ? [result.unavailableRelay] : []
    ),
  }
}

function gatewayOperations(
  network: { readonly id: string; readonly relayIds: ReadonlyArray<string> },
  relayById: ReadonlyMap<string, PersistedRelay>,
  subject: string,
  removeFromControlPlane?: (
    gateway: Pick<GatewayOverview, "hostname" | "subnet"> & {
      status: Pick<GatewayOverview["status"], "ipv4Address">
    }
  ) => Promise<void>
): GatewayOperations<GatewayOverview> {
  return {
    apply: async (target, input) => {
      const relay = relayById.get(target.relayId)
      if (!relay) throw new Error("The network's node is unavailable")
      const stack = tunnelSchema.parse(
        await relayRpc(relay, "tunnel.apply", input, 240_000, subject)
      )
      return {
        ...stack,
        relayId: target.relayId,
        relayName: target.relayName,
      }
    },
    remove: async (gateway, mode) => {
      const controlPlaneDeviceRemoved =
        mode === "commit" && Boolean(removeFromControlPlane)
      if (controlPlaneDeviceRemoved) {
        await removeFromControlPlane?.(gateway)
      }
      await removeGateway(
        gateway,
        relayById,
        mode,
        subject,
        controlPlaneDeviceRemoved
      )
    },
    // Found by its hostname, as it never reported an address.
    ...(removeFromControlPlane
      ? {
          discard: (target: DesiredGateway) =>
            removeFromControlPlane({
              hostname: target.hostname,
              status: { ipv4Address: null },
              subnet: "",
            }),
        }
      : {}),
    // The save holds the network's `#settings`, as every DNS rewrite does.
    rewriteDns: () => writeTunnelDns(network, subject),
  }
}

async function removeGateway(
  gateway: Pick<GatewayOverview, "id" | "relayId">,
  relayById: ReadonlyMap<string, PersistedRelay>,
  mode: "commit" | "prepare" | "rollback",
  subject: string,
  controlPlaneDeviceRemoved = false
): Promise<void> {
  const relay = relayById.get(gateway.relayId)
  if (!relay) throw new Error("The network's node is unavailable")
  await relayRpc(
    relay,
    "tunnel.remove",
    { controlPlaneDeviceRemoved, id: gateway.id, mode },
    120_000,
    subject
  )
}

async function invalidateRelaySnapshots(
  relayIds: ReadonlyArray<string>
): Promise<void> {
  await Promise.all(
    [...new Set(relayIds)].map((relayId) =>
      runAppEffect(
        "relay.tailscale.snapshot.invalidate",
        invalidateRelayCache(relayCachePolicy.snapshot(relayId))
      )
    )
  )
}

function gatewayHostname(
  stackName: string,
  relayName: string,
  relayId: string
): string {
  const slug = `${stackName}-${relayName}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
  const suffix = createHash("sha256").update(relayId).digest("hex").slice(0, 6)
  return `${slug.slice(0, Math.max(1, 56 - suffix.length)).replace(/-+$/u, "")}-${suffix}`
}

function loadTunnelDefinitions() {
  return runAppEffect("tunnel.load", loadTunnelDefinitionsEffect())
}

function saveTunnelDefinition(definition: TunnelDefinition, ownerId: string) {
  return runAppEffect(
    "tunnel.save",
    saveTunnelDefinitionEffect(definition, ownerId)
  )
}

export function loadTunnelCredential(id: string) {
  return runAppEffect("tunnel.integration.load", loadTunnelCredentialEffect(id))
}

function createTailscaleNodeAuthKey(
  credential: TailscaleOAuthCredential,
  nodeName: string
) {
  return runAppEffect(
    "tailscale.authKey.create",
    createTailscaleNodeAuthKeyEffect(credential, nodeName)
  )
}

function removeTailscaleControlPlaneDevice(
  credential: TailscaleOAuthCredential,
  gateway: Pick<GatewayOverview, "hostname" | "subnet"> & {
    status: Pick<GatewayOverview["status"], "ipv4Address">
  }
) {
  return runAppEffect(
    "tailscale.controlPlane.removeDevice",
    removeTailscaleControlPlaneDeviceEffect(credential, gateway)
  )
}

async function synchronizeTailscaleControlPlane(
  credential: TailscaleOAuthCredential,
  stack: TunnelOverview & { previousDomains?: ReadonlyArray<string> }
) {
  const result = await runAppEffect(
    "tailscale.controlPlane.sync",
    syncTailscaleControlPlaneEffect(credential, stack)
  )
  await recordTailscaleSync(stack.id, null)
  return result
}

export function inspectTailscaleControlPlane(
  credential: TailscaleOAuthCredential,
  stack: TunnelOverview,
  previousDomains?: ReadonlyArray<string>
) {
  return runAppEffect(
    "tailscale.controlPlane.inspect",
    inspectTailscaleControlPlaneEffect(credential, {
      ...stack,
      ...(previousDomains ? { previousDomains } : {}),
    })
  )
}

function recordTailscaleSync(id: string, error: string | null) {
  return runAppEffect(
    "tunnel.integration.recordSync",
    recordTunnelSyncEffect(id, error)
  )
}

function replaceTunnelDefinition(
  definitions: ReadonlyArray<TunnelDefinition>,
  next: TunnelDefinition
): Array<TunnelDefinition> {
  return [
    ...definitions.filter((definition) => definition.id !== next.id),
    next,
  ]
}

async function requireUnusedDomains(
  definitions: ReadonlyArray<TunnelDefinition>,
  id: string,
  domains: ReadonlyArray<string>
): Promise<void> {
  for (const definition of definitions) {
    if (definition.id === id) continue
    const taken = domains.find((domain) => definition.domains.includes(domain))
    if (taken) {
      throw new Error(`.${taken} is already a TLD of ${definition.name}`)
    }
  }
  // Nor may it overlap a public domain, which it would answer for on its
  // tailnet.
  const conflict = await runAppEffect(
    "domains.tunnelConflict",
    tunnelDomainConflictEffect(domains, id)
  )
  if (conflict) throw new Error(conflict)
}

export function requireCompleteGatewayList(
  unavailableRelays: TunnelsResult["unavailableRelays"]
): void {
  if (unavailableRelays.length === 0) return
  const names = unavailableRelays.map(({ name }) => name).join(", ")
  throw new Error(
    `tunnels cannot be changed while these Relays are unavailable: ${names}`
  )
}

function tailscaleOverviewForGateways(
  definition: TunnelDefinition,
  gateways: ReadonlyArray<GatewayOverview>,
  previousDomains?: ReadonlyArray<string>
): TunnelOverview & { previousDomains?: ReadonlyArray<string> } {
  // Tailscale is told its routes and TLDs, never its members' names.
  return {
    ...definition,
    access: { manage: true, gateways: {} },
    names: [],
    bindings: gateways.flatMap(({ bindings, relayId, relayName }) =>
      bindings.map((binding) => ({
        ...binding,
        label: "",
        relayId,
        relayName,
      }))
    ),
    gateways: [...gateways],
    ...(previousDomains ? { previousDomains } : {}),
  }
}

async function restoreTailscaleControlPlane(
  credential: TailscaleOAuthCredential,
  definition: TunnelDefinition,
  gateways: ReadonlyArray<GatewayOverview>
): Promise<void> {
  await runAppEffect(
    "tailscale.controlPlane.restore",
    syncTailscaleControlPlaneEffect(
      credential,
      tailscaleOverviewForGateways(definition, gateways)
    )
  )
}

async function reconcileTailscaleDomainAfterDefinitionFailure(
  credential: TailscaleOAuthCredential,
  failedDefinition: TunnelDefinition,
  relays: ReadonlyArray<PersistedRelay>
): Promise<TunnelDefinition | null> {
  // The losing request may already have replaced this split-DNS entry. Clear
  // it on that tunnel before restoring whichever network actually won the
  // database uniqueness race.
  await runAppEffect(
    "tailscale.controlPlane.domain.clearAfterDefinitionFailure",
    syncTailscaleControlPlaneEffect(
      credential,
      tailscaleOverviewForGateways(failedDefinition, [])
    )
  )

  const [definitions, current] = await Promise.all([
    loadTunnelDefinitions(),
    loadGateways(relays),
  ])
  requireCompleteGatewayList(current.unavailableRelays)
  const owner =
    definitions.find(
      (definition) =>
        definition.id !== failedDefinition.id &&
        definition.domains.some((domain) =>
          failedDefinition.domains.includes(domain)
        )
    ) ?? null
  if (!owner) return null

  // Clearing the losing request's tunnel is sufficient when the database
  // owner is not integrated. Never use one network's `/tunnel/-` credential
  // to modify another network's DNS or routes.
  if (!owner.integration) return owner
  const ownerCredential = await loadTunnelCredential(owner.id)
  await synchronizeTailscaleControlPlane(
    ownerCredential,
    tailscaleOverviewForGateways(
      owner,
      current.gateways.filter((gateway) => gateway.tailnetId === owner.id)
    )
  )
  return owner
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Tailscale setup failed"
}

function recordTailscaleSyncFailure(id: string) {
  return (cause: unknown) =>
    promiseEffect(() => recordTailscaleSync(id, errorMessage(cause))).pipe(
      Effect.andThen(
        Effect.sync(() => {
          publishTailscaleChange()
        })
      )
    )
}

function promiseEffect<TResult>(
  run: () => PromiseLike<TResult>
): Effect.Effect<TResult, unknown> {
  return Effect.tryPromise({ try: run, catch: (cause) => cause })
}
