import { createHash } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  appTailscaleMember,
  databaseTailscaleMember,
  instanceTailscaleMember,
  MAXIMUM_TUNNEL_BINDINGS,
  permissionRelayReach,
  relayIdSchema,
  relayInstanceNameSchema,
  relaySnapshotSchema,
  relayTailscaleDomainSchema,
  relayTailscaleAuthKeySchema,
  tunnelIdSchema,
  tunnelSchema,
  tunnelsSchema,
  relayTailscaleSubdomainSchema,
  tailscaleMemberIdSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  observeTunnelsEffect,
  reconcileTunnelsEffect,
  requestTailnetCleanupEffect,
} from "@/effect/tunnels"
import {
  createTailscaleNodeAuthKeyEffect,
  inspectTailscaleControlPlaneEffect,
  removeTailscaleControlPlaneDeviceEffect,
  syncTailscaleControlPlaneEffect,
  verifyTailscaleOAuthCredentialEffect,
} from "@/effect/tailscale-api"
import {
  createTailnetDefinitionEffect,
  loadTailnetCredentialEffect,
  loadTailnetDefinitionsEffect,
  recordTailnetSyncEffect,
  saveTailnetIntegrationEffect,
  tailnetRelaysEffect,
  saveTailnetDefinitionEffect,
  type TailscaleIntegration,
  type TailnetDefinition,
  type TailscaleOAuthCredential,
} from "@/effect/tailnets"
import { reserveInstanceId } from "@/effect/instance-ids"
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
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, listUserGrants } from "@/lib/access-control"
import { accessPermissions, type AccessPermission } from "@/lib/permissions"
import { effectiveScopePermissions } from "@/lib/resource-permissions"
import { listTunnelRecordsEffect } from "@/server/tunnel-access.server"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import { relayRpc } from "@/lib/relay-connection"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { startTailnetDeletion } from "@/lib/tailnet-deletion.server"
import { writeTailnetDns } from "@/lib/tunnel-dns.server"
import { tailscaleMemberProblem } from "@/lib/tailscale-members"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { tailnetKey, tailnetSettingsKey } from "@/lib/tunnel-lanes"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  applyTunnelPlanEffect,
  type DesiredTunnel,
  type TunnelOperations,
} from "@/server/tunnel-orchestration"
import type { RelaySnapshot, Tunnel } from "@workspace/contracts"

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

const saveTailnetSchema = z.strictObject({
  authKey: relayTailscaleAuthKeySchema.optional(),
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
  // The Relays it has a tunnel on. A Relay a member connects on gets one.
  relayIds: z.array(relayIdSchema).max(64),
})

const createTailnetSchema = z.strictObject({
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

const removeTailnetSchema = z.strictObject({
  id: tunnelIdSchema,
})

const configureTailscaleIntegrationSchema = z.strictObject({
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

const previewTailscaleIntegrationSchema = configureTailscaleIntegrationSchema
  .omit({ previousDomains: true })
  .extend({ clientSecret: tailscaleClientSecretSchema })

const syncTailscaleIntegrationSchema = z.strictObject({
  id: tunnelIdSchema,
})

export interface TunnelOverview extends Tunnel {
  relayId: string
  relayName: string
}

/** One of a connected member's names in its tailnet. */
export type TailnetName = Omit<TunnelName, "tailnetId">

export interface TailnetOverview {
  /** What the viewer may do: change the tailnet, and each tunnel's own. */
  access: {
    manage: boolean
    /** By tunnel ID, what every kind of instance has that it may do. */
    tunnels: Record<string, ReadonlyArray<AccessPermission>>
  }
  bindings: Array<{
    address: string
    enabled: boolean
    /** Its generated name's label, under the tailnet's first TLD. */
    label: string
    memberId: string
    relayId: string
    relayName: string
  }>
  deployments: Array<TunnelOverview>
  cleanup: TailnetDefinition["cleanup"]
  domains: Array<string>
  id: string
  integration: TailscaleIntegration | null
  name: string
  /** Every name of everything it connects, generated ones first. */
  names: Array<TailnetName>
}

export interface TailnetsResult {
  stacks: Array<TailnetOverview>
  unavailableRelays: Array<{
    id: string
    message: string
    name: string
  }>
}

/**
 * The tailnets the viewer sees, and what they may do with each. A platform
 * administrator sees and changes them all. Anyone else sees the tunnels
 * they own or reach through a grant on its Relay, as `requireTunnelPermission`
 * allows, each in its tailnet with what it connects there.
 */
export const getTailnets = createServerFn({ method: "GET" }).handler(
  async () => {
    const user = await requireEligibleResourceUser()
    const result = await loadTailnets()
    if (isPlatformAdmin(user)) return result
    const [records, grants] = await Promise.all([
      runAppEffect("tunnels.list", listTunnelRecordsEffect()),
      listUserGrants(user.id),
    ])
    const owners = new Map(records.map(({ id, ownerId }) => [id, ownerId]))
    const permissionsOf = (tunnel: TunnelOverview) => {
      if (owners.get(tunnel.id) === user.id) return tunnelPermissions
      const held = effectiveScopePermissions(grants, {
        relayId: tunnel.relayId,
        resourceId: tunnel.relayId,
        resourceType: "relay",
      })
      return held.has("instance.read")
        ? tunnelPermissions.filter((permission) => held.has(permission))
        : null
    }
    const stacks = result.stacks.flatMap((stack): Array<TailnetOverview> => {
      const tunnels: Record<string, ReadonlyArray<AccessPermission>> = {}
      for (const deployment of stack.deployments) {
        const permissions = permissionsOf(deployment)
        if (permissions) tunnels[deployment.id] = permissions
      }
      const deployments = stack.deployments.filter(
        ({ id }) => tunnels[id] !== undefined
      )
      if (deployments.length === 0) return []
      const relays = new Set(deployments.map(({ relayId }) => relayId))
      const bindings = stack.bindings.filter(({ relayId }) =>
        relays.has(relayId)
      )
      const members = new Set(bindings.map(({ memberId }) => memberId))
      return [
        {
          ...stack,
          access: { manage: false, tunnels },
          bindings,
          deployments,
          // Its Tailscale login is for those who change the tailnet.
          integration: null,
          names: stack.names.filter(({ memberId }) => members.has(memberId)),
        },
      ]
    })
    // Only the Relays of tunnels the viewer sees, listed or not.
    const relays = new Set(
      records.flatMap(({ ownerId, relayId }) =>
        ownerId === user.id ||
        effectiveScopePermissions(grants, {
          relayId,
          resourceId: relayId,
          resourceType: "relay",
        }).has("instance.read")
          ? [relayId]
          : []
      )
    )
    return {
      stacks,
      unavailableRelays: result.unavailableRelays.filter(({ id }) =>
        relays.has(id)
      ),
    }
  }
)

// Reading it, and what every kind of instance has, as its pages check them.
const tunnelPermissions: ReadonlyArray<AccessPermission> = [
  "instance.read",
  ...accessPermissions.filter(
    (permission) => permissionRelayReach(permission).length > 0
  ),
]

const createTailnetOperation = operation<
  z.infer<typeof createTailnetSchema> & { id: string }
>()({
  name: "tailnet.create",
  doing: "Creating this tailnet",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tailnetKey(input.id))],
  run: ({ context: user, input }) =>
    promiseEffect(() => createTailnetHandler(user, input)),
  audit: ({ input }) => ({ id: input.id, kind: "tailnet" }),
})

export const createTailnet = createServerFn({ method: "POST" })
  .validator(createTailnetSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    return runOperationPromise(
      createTailnetOperation,
      { ...data, id: await reserveInstanceId("group") },
      { user }
    )
  })

async function createTailnetHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof createTailnetSchema> & { id: string }
) {
  const definitions = await loadTailnetDefinitions()
  requireUnusedDomains(definitions, data.id, data.domains)
  const verified = await runAppEffect(
    "tailscale.oauth.verify",
    verifyTailscaleOAuthCredentialEffect(data.clientId, data.clientSecret, [
      data.tag,
    ])
  )
  await runAppEffect(
    "tailnet.create",
    createTailnetDefinitionEffect(
      {
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
  return loadTailnets()
}

const configureTailscaleIntegrationOperation = operation<
  z.infer<typeof configureTailscaleIntegrationSchema>
>()({
  name: "tailnet.connect",
  doing: "Connecting this network to Tailscale",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tailnetSettingsKey(input.id))],
  run: ({ input }) =>
    promiseEffect(() => configureTailscaleIntegrationHandler(input)),
  audit: ({ input }) => ({ id: input.id, kind: "tailnet" }),
})

export const configureTailscaleIntegration = createServerFn({ method: "POST" })
  .validator(configureTailscaleIntegrationSchema)
  .handler(async ({ data }) =>
    runOperationPromise(configureTailscaleIntegrationOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function configureTailscaleIntegrationHandler(
  data: z.infer<typeof configureTailscaleIntegrationSchema>
) {
  const definitions = await loadTailnetDefinitions()
  const definition = definitions.find(({ id }) => id === data.id)
  if (!definition) throw new Error("Tailnet not found")
  // Its removal still needs the credentials it was set up with.
  if (definition.cleanup) {
    throw new Error("This tailnet is being removed")
  }
  const clientSecret =
    data.clientSecret ?? (await loadTailnetCredential(data.id)).clientSecret
  const verified = await runAppEffect(
    "tailscale.oauth.verify",
    verifyTailscaleOAuthCredentialEffect(data.clientId, clientSecret, [
      data.tag,
    ])
  )
  await runAppEffect(
    "tailnet.integration.save",
    saveTailnetIntegrationEffect(data.id, verified, clientSecret)
  )
  const credential = {
    ...verified,
    clientSecret,
  } satisfies TailscaleOAuthCredential
  const configured = await Effect.runPromise(
    promiseEffect(async () => {
      const result = await loadTailnets()
      requireCompleteTunnelList(result.unavailableRelays)
      const stack = result.stacks.find(({ id }) => id === data.id)
      if (!stack) throw new Error("Tailnet not found")
      if (stack.domains.join(" ") !== data.domains.join(" ")) {
        throw new Error("The tailnet's TLDs changed before setup completed")
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
        stacks: await loadTailnets(),
      }
    }).pipe(Effect.tapError(recordTailscaleSyncFailure(data.id)))
  )
  publishTailscaleChange()
  return configured
}

export const previewTailscaleIntegration = createServerFn({ method: "POST" })
  .validator(previewTailscaleIntegrationSchema)
  .handler(async ({ data }) => {
    await requireTailscaleAdministrator()
    const result = await loadTailnets()
    requireCompleteTunnelList(result.unavailableRelays)
    const stack = result.stacks.find(({ id }) => id === data.id)
    if (!stack) throw new Error("Tailnet not found")
    const verified = await runAppEffect(
      "tailscale.oauth.verify",
      verifyTailscaleOAuthCredentialEffect(data.clientId, data.clientSecret, [
        data.tag,
      ])
    )
    const credential = {
      ...verified,
      clientSecret: data.clientSecret,
    } satisfies TailscaleOAuthCredential
    return {
      credential: verified,
      inspection: await inspectTailscaleControlPlane(
        credential,
        { ...stack, domains: data.domains },
        stack.domains
      ),
    }
  })

export const getTailscaleIntegrationStatus = createServerFn({ method: "GET" })
  .validator(syncTailscaleIntegrationSchema)
  .handler(async ({ data }) => {
    await requireTailscaleAdministrator()
    const [credential, result] = await Promise.all([
      loadTailnetCredential(data.id),
      loadTailnets(),
    ])
    requireCompleteTunnelList(result.unavailableRelays)
    const stack = result.stacks.find(({ id }) => id === data.id)
    if (!stack) throw new Error("Tailnet not found")
    return {
      inspection: await inspectTailscaleControlPlane(credential, stack),
      stacks: result,
    }
  })

const syncTailscaleIntegrationOperation = operation<
  z.infer<typeof syncTailscaleIntegrationSchema>
>()({
  name: "tailnet.sync",
  doing: "Syncing this network with Tailscale",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tailnetSettingsKey(input.id))],
  run: ({ input }) =>
    promiseEffect(() => syncTailscaleIntegrationHandler(input)),
  audit: ({ input }) => ({ id: input.id, kind: "tailnet" }),
})

export const syncTailscaleIntegration = createServerFn({ method: "POST" })
  .validator(syncTailscaleIntegrationSchema)
  .handler(async ({ data }) =>
    runOperationPromise(syncTailscaleIntegrationOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function syncTailscaleIntegrationHandler(
  data: z.infer<typeof syncTailscaleIntegrationSchema>
) {
  const [credential, result] = await Promise.all([
    loadTailnetCredential(data.id),
    loadTailnets(),
  ])
  requireCompleteTunnelList(result.unavailableRelays)
  const stack = result.stacks.find(({ id }) => id === data.id)
  if (!stack) throw new Error("Tailnet not found")
  // Its removal takes its nodes away; a sync would point DNS back at them.
  if (stack.cleanup) throw new Error("This tailnet is being removed")
  const synchronized = await Effect.runPromise(
    promiseEffect(async () => {
      await synchronizeTailscaleControlPlane(credential, stack)
      return loadTailnets()
    }).pipe(Effect.tapError(recordTailscaleSyncFailure(data.id)))
  )
  publishTailscaleChange()
  return synchronized
}

const saveTailnetOperation = operation<z.infer<typeof saveTailnetSchema>>()({
  name: "tailnet.save",
  doing: "Saving this tailnet",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tailnetSettingsKey(input.id))],
  run: ({ context: user, input }) =>
    promiseEffect(() => saveTailnetHandler(user, input)),
  audit: ({ input }) => ({ id: input.id, kind: "tailnet" }),
})

export const saveTailnet = createServerFn({ method: "POST" })
  .validator(saveTailnetSchema)
  .handler(async ({ data }) =>
    runOperationPromise(saveTailnetOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function saveTailnetHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof saveTailnetSchema>
) {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const relayById = new Map(relays.map((relay) => [relay.id, relay]))
  const id = data.id
  const firstDomain = data.domains[0]!
  const duplicateLabel = data.bindings.find(
    (binding, index, bindings) =>
      binding.label !== undefined &&
      bindings.findIndex((candidate) => candidate.label === binding.label) !==
        index
  )
  if (duplicateLabel) {
    throw new Error(
      `${duplicateLabel.label}.${firstDomain} is chosen more than once`
    )
  }
  const duplicateMember = data.bindings.find(
    (binding, index, bindings) =>
      bindings.findIndex(
        (candidate) => candidate.memberId === binding.memberId
      ) !== index
  )
  if (duplicateMember) {
    throw new Error("Something connects to a tailnet through one tunnel")
  }
  // A name is unique in its tailnet: another member's, alias or not, stays.
  const names = await runAppEffect(
    "tunnelNames.list",
    listTunnelNamesEffect([id])
  )
  for (const binding of data.bindings) {
    if (binding.label === undefined) continue
    const taken = names.find(
      (name) =>
        name.memberId !== binding.memberId &&
        name.label === binding.label &&
        name.domain === firstDomain
    )
    if (taken) {
      throw new Error(
        `${binding.label}.${firstDomain} is already another member's name`
      )
    }
  }

  const grouped = new Map<string, typeof data.bindings>(
    data.relayIds.map((relayId) => [relayId, []])
  )
  for (const binding of data.bindings) {
    const relayBindings = grouped.get(binding.relayId) ?? []
    relayBindings.push(binding)
    grouped.set(binding.relayId, relayBindings)
  }
  for (const relayId of grouped.keys()) {
    if (!relayById.has(relayId)) {
      throw new Error(
        "A Relay this tailnet would have a tunnel on is unavailable"
      )
    }
  }

  const [currentResult, definitions] = await Promise.all([
    loadTunnels(relays),
    loadTailnetDefinitions(),
  ])
  const current = currentResult.deployments
  const currentForStack = current.filter(
    (deployment) => deployment.tailnetId === id
  )
  const definition = definitions.find((candidate) => candidate.id === id)
  if (!definition) throw new Error("Tailnet not found")
  if (
    !definition.integration &&
    !sameTailscaleBindings(data.bindings, currentForStack, grouped.keys())
  ) {
    throw new Error(
      "Connect this network to Tailscale before assigning servers"
    )
  }
  if (definition.cleanup) {
    throw new Error("This tailnet is being removed")
  }
  const currentRelayIds = new Set(currentForStack.map(({ relayId }) => relayId))
  requireUnusedDomains(definitions, id, data.domains)
  requireCompleteTunnelList(currentResult.unavailableRelays)
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
        "A Relay this tailnet would have a tunnel on is unavailable"
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

  const nextDefinition = {
    cleanup: definition.cleanup,
    domains: data.domains,
    id,
    integration: definition.integration,
    name: data.name,
  }
  // A Relay the tailnet has a tunnel on keeps it; one it doesn't gets a
  // new tunnel, with an ID of its own.
  const tunnelOn = new Map(
    currentForStack.map((deployment) => [deployment.relayId, deployment.id])
  )
  const desired = await Promise.all(
    [...grouped.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(async ([relayId, bindings]): Promise<DesiredTunnel> => {
        const relay = relayById.get(relayId)
        if (!relay) {
          throw new Error(
            "A Relay this tailnet would have a tunnel on is unavailable"
          )
        }
        return {
          bindings: bindings.map(({ enabled, memberId }) => ({
            enabled,
            memberId,
          })),
          hostname: deploymentHostname(data.name, relay.name, relay.id),
          id: tunnelOn.get(relayId) ?? (await reserveInstanceId("tunnel")),
          relayId,
          relayName: relay.name,
        }
      })
  )
  const integrationCredential = definition?.integration
    ? await loadTailnetCredential(id)
    : null
  const newTargets = desired.filter(
    ({ relayId }) => !currentRelayIds.has(relayId)
  )
  if (newTargets.length > 1 && !integrationCredential) {
    throw new Error(
      "A manual auth key can add one new Relay at a time. Install the first Relay, connect Kiln to Tailscale, then add the remaining Relays."
    )
  }
  const desiredRelayIds = new Set(grouped.keys())
  const removed = currentForStack.filter(
    ({ relayId }) => !desiredRelayIds.has(relayId)
  )
  const reservedSubnets = new Set<string>()
  for (const deployment of current) {
    if (deployment.tailnetId !== id) reservedSubnets.add(deployment.subnet)
  }
  const synchronized = await runAppEffect(
    "tailscale.deployment.save",
    applyTunnelPlanEffect({
      authKey: data.authKey,
      authKeyForTarget: integrationCredential
        ? async (target) =>
            createTailscaleNodeAuthKey(integrationCredential, target.hostname)
        : undefined,
      current: currentForStack,
      desired,
      domains: data.domains,
      id,
      name: data.name,
      operations: tunnelOperations(
        // Where it's going and where it was, for DNS after a rollback too.
        { id, relayIds: [...desiredRelayIds, ...currentRelayIds] },
        relayById,
        user.id,
        integrationCredential
          ? (deployment) =>
              removeTailscaleControlPlaneDevice(
                integrationCredential,
                deployment
              )
          : undefined
      ),
      reservedSubnets,
      beforeFinalize: async (deployments) => {
        if (integrationCredential && definition?.integration) {
          const integration = definition.integration
          await Effect.runPromise(
            promiseEffect(() =>
              synchronizeTailscaleControlPlane(
                integrationCredential,
                tailscaleOverviewForDeployments(
                  nextDefinition,
                  deployments,
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
            saveTailnetDefinition(nextDefinition, user.id)
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
                      `A TLD of this tailnet is already used by ${domainOwnerAfterConflict.name}`,
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
    "tailscale.cleanup.deployments.reconcile",
    reconcileTunnelsEffect(
      id,
      synchronized,
      removed.map(({ relayId }) => relayId)
    )
  )
  // Its members' names, now its tunnels have them: each connected one's
  // generated name under its first TLD, as chosen, and no name of a member
  // that left or under a TLD it no longer has. Its DNS then serves them.
  await runAppEffect(
    "tunnelNames.save",
    Effect.gen(function* () {
      yield* setGeneratedTunnelNamesEffect(
        id,
        data.bindings.map(({ label, memberId }) => ({
          domain: firstDomain,
          label: labelOf(memberId, label),
          memberId,
        }))
      )
      yield* keepTunnelNamesOfEffect(
        id,
        data.bindings.map(({ memberId }) => memberId),
        data.domains
      )
    })
  )
  await writeTailnetDns({ id, relayIds: [...desiredRelayIds] }, user.id)
  publishTailscaleChange()
  return {
    stacks: groupTunnels(
      [
        ...current.filter((deployment) => deployment.tailnetId !== id),
        ...synchronized,
      ],
      replaceTailnetDefinition(definitions, nextDefinition),
      await runAppEffect("tunnelNames.list", listTunnelNamesEffect([id]))
    ),
    unavailableRelays: currentResult.unavailableRelays,
  }
}

const tunnelAliasSchema = z.strictObject({
  domain: relayTailscaleDomainSchema,
  label: relayTailscaleSubdomainSchema,
  memberId: tailscaleMemberIdSchema,
  tailnetId: tunnelIdSchema,
})

const addTunnelAliasOperation = operation<z.infer<typeof tunnelAliasSchema>>()({
  name: "tailnet.alias.add",
  doing: "Giving this member another name",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tailnetSettingsKey(input.tailnetId))],
  run: ({ context: user, input }) =>
    promiseEffect(() => addTunnelAliasHandler(user, input)),
  audit: ({ input }) => ({ id: input.tailnetId, kind: "tailnet" }),
})

/** Gives a connected member another name in its tailnet. */
export const addTunnelAlias = createServerFn({ method: "POST" })
  .validator(tunnelAliasSchema)
  .handler(async ({ data }) =>
    runOperationPromise(addTunnelAliasOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function addTunnelAliasHandler(
  user: AuthenticatedUser,
  input: z.infer<typeof tunnelAliasSchema>
) {
  const definition = (await loadTailnetDefinitions()).find(
    ({ id }) => id === input.tailnetId
  )
  if (!definition) throw new Error("Tailnet not found")
  if (!definition.domains.includes(input.domain)) {
    throw new Error(`.${input.domain} isn't one of this tailnet's TLDs`)
  }
  const names = await runAppEffect(
    "tunnelNames.list",
    listTunnelNamesEffect([input.tailnetId])
  )
  if (
    !names.some((name) => name.generated && name.memberId === input.memberId)
  ) {
    throw new Error("Connect it to this tailnet before giving it a name")
  }
  if (
    names.some(
      (name) => name.label === input.label && name.domain === input.domain
    )
  ) {
    throw new Error(`${input.label}.${input.domain} is already a name here`)
  }
  await runAppEffect("tunnelNames.addAlias", addTunnelAliasEffect(input))
  await rewriteTailnetNames(input.tailnetId, user.id)
  return loadTailnets()
}

const removeTunnelAliasSchema = z.strictObject({ id: z.uuid() })

const removeTunnelAliasOperation = operation<
  z.infer<typeof removeTunnelAliasSchema> & { tailnetId: string }
>()({
  name: "tailnet.alias.remove",
  doing: "Taking away this name",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tailnetSettingsKey(input.tailnetId))],
  run: ({ context: user, input }) =>
    promiseEffect(async () => {
      const removed = await runAppEffect(
        "tunnelNames.removeAlias",
        removeTunnelAliasEffect(input.id)
      )
      if (!removed)
        throw new Error("A generated name can be renamed, not removed")
      await rewriteTailnetNames(input.tailnetId, user.id)
      return loadTailnets()
    }),
  audit: ({ input }) => ({ id: input.tailnetId, kind: "tailnet" }),
})

/** Takes away one of a member's aliases. Its generated name stays. */
export const removeTunnelAlias = createServerFn({ method: "POST" })
  .validator(removeTunnelAliasSchema)
  .handler(async ({ data }) => {
    const user = await requireEligibleResourceUser()
    const name = await runAppEffect(
      "tunnelNames.load",
      loadTunnelNameEffect(data.id)
    )
    if (!name) throw new Error("That name is gone")
    return runOperationPromise(
      removeTunnelAliasOperation,
      { ...data, tailnetId: name.tailnetId },
      { user }
    )
  })

// Serves a tailnet's names as they are now, on every tunnel it has.
async function rewriteTailnetNames(tailnetId: string, subject: string) {
  const relays = await runAppEffect(
    "tailnets.relays",
    tailnetRelaysEffect([tailnetId])
  )
  await writeTailnetDns(
    { id: tailnetId, relayIds: relays.get(tailnetId) ?? [] },
    subject
  )
  publishTailscaleChange()
}

const removeTailnetOperation = operation<z.infer<typeof removeTailnetSchema>>()(
  {
    name: "tailnet.remove",
    doing: "Removing this tailnet",
    authorize: ({ user }) => tailscaleAdministrator(user),
    locks: ({ input }) => [exclusive(tailnetKey(input.id))],
    run: ({ context: user, input }) =>
      promiseEffect(() => removeTailnetHandler(user, input)),
    audit: ({ input }) => ({ id: input.id, kind: "tailnet" }),
  }
)

export const removeTailnet = createServerFn({ method: "POST" })
  .validator(removeTailnetSchema)
  .handler(async ({ data }) =>
    runOperationPromise(removeTailnetOperation, data, {
      user: await requireEligibleResourceUser(),
    })
  )

async function removeTailnetHandler(
  user: AuthenticatedUser,
  data: z.infer<typeof removeTailnetSchema>
) {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const [current, definitions] = await Promise.all([
    loadTunnels(relays),
    loadTailnetDefinitions(),
  ])
  const deployments = current.deployments.filter(
    (deployment) => deployment.tailnetId === data.id
  )
  const definition = definitions.find(({ id }) => id === data.id)
  if (!definition) throw new Error("Tailnet not found")
  await runAppEffect(
    "tailscale.cleanup.request",
    requestTailnetCleanupEffect(data.id, user.id, deployments).pipe(
      Effect.andThen(startTailnetDeletion(data.id, user.id))
    )
  )
  publishTailscaleChange()
  return loadTailnets()
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

async function requireTailscaleAdministrator() {
  const user = await requireEligibleResourceUser()
  if (!isPlatformAdmin(user)) {
    throw new Error("Platform administrator access required")
  }
  return user
}

async function loadTailnets(): Promise<TailnetsResult> {
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const [definitions, result] = await Promise.all([
    loadTailnetDefinitions(),
    loadTunnels(relays),
  ])
  const definitionIds = new Set(definitions.map(({ id }) => id))
  const observed = result.deployments.filter((deployment) =>
    definitionIds.has(deployment.tailnetId)
  )
  if (observed.length > 0) {
    await Effect.runPromise(
      promiseEffect(() =>
        runAppEffect(
          "tailscale.cleanup.deployments.observe",
          observeTunnelsEffect(observed)
        )
      ).pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.sync(() =>
            console.warn(
              "[Kiln] Could not persist observed Tailscale deployments:",
              cause
            )
          )
        )
      )
    )
  }
  return {
    stacks: groupTunnels(
      result.deployments,
      definitions,
      await runAppEffect(
        "tunnelNames.list",
        listTunnelNamesEffect(definitions.map(({ id }) => id))
      )
    ),
    unavailableRelays: result.unavailableRelays,
  }
}

function groupTunnels(
  deployments: ReadonlyArray<TunnelOverview>,
  definitions: ReadonlyArray<TailnetDefinition>,
  names: ReadonlyArray<TunnelName>
): Array<TailnetOverview> {
  // Each member's generated name in each tailnet, by both.
  const generated = new Map(
    names
      .filter((name) => name.generated)
      .map((name) => [`${name.tailnetId}:${name.memberId}`, name.label])
  )
  const grouped = new Map<string, TailnetOverview>()
  const namesOf = (tailnetId: string) =>
    names.flatMap(({ tailnetId: of, ...name }) =>
      of === tailnetId ? [name] : []
    )
  for (const definition of definitions) {
    grouped.set(definition.id, {
      ...definition,
      access: { manage: true, tunnels: {} },
      bindings: [],
      deployments: [],
      names: namesOf(definition.id),
    })
  }
  for (const deployment of deployments) {
    const stack = grouped.get(deployment.tailnetId) ?? {
      access: { manage: true, tunnels: {} },
      bindings: [],
      cleanup: null,
      deployments: [],
      domains: deployment.domains,
      id: deployment.tailnetId,
      integration: null,
      name: deployment.name,
      names: namesOf(deployment.tailnetId),
    }
    stack.deployments.push(deployment)
    stack.access.tunnels[deployment.id] = tunnelPermissions
    stack.bindings.push(
      ...deployment.bindings.map((binding) => ({
        ...binding,
        label:
          generated.get(`${deployment.tailnetId}:${binding.memberId}`) ?? "",
        relayId: deployment.relayId,
        relayName: deployment.relayName,
      }))
    )
    grouped.set(deployment.tailnetId, stack)
  }
  return [...grouped.values()].sort((left, right) =>
    left.name.localeCompare(right.name)
  )
}

async function loadTunnels(relays: ReadonlyArray<PersistedRelay>): Promise<{
  deployments: Array<TunnelOverview>
  snapshots: Map<string, RelaySnapshot>
  unavailableRelays: TailnetsResult["unavailableRelays"]
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
            deployments: stacks.map((stack) => ({
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
              deployments: [],
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
    deployments: results.flatMap((result) => result.deployments),
    snapshots,
    unavailableRelays: results.flatMap((result) =>
      result.unavailableRelay ? [result.unavailableRelay] : []
    ),
  }
}

function tunnelOperations(
  network: { readonly id: string; readonly relayIds: ReadonlyArray<string> },
  relayById: ReadonlyMap<string, PersistedRelay>,
  subject: string,
  removeFromControlPlane?: (deployment: TunnelOverview) => Promise<void>
): TunnelOperations<TunnelOverview> {
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
    remove: async (deployment, mode) => {
      const controlPlaneDeviceRemoved =
        mode === "commit" && Boolean(removeFromControlPlane)
      if (controlPlaneDeviceRemoved) {
        await removeFromControlPlane?.(deployment)
      }
      await removeDeployment(
        deployment,
        relayById,
        mode,
        subject,
        controlPlaneDeviceRemoved
      )
    },
    // The save holds the network's `#settings`, as every DNS rewrite does.
    rewriteDns: () => writeTailnetDns(network, subject),
  }
}

async function removeDeployment(
  deployment: Pick<TunnelOverview, "id" | "relayId">,
  relayById: ReadonlyMap<string, PersistedRelay>,
  mode: "commit" | "prepare" | "rollback",
  subject: string,
  controlPlaneDeviceRemoved = false
): Promise<void> {
  const relay = relayById.get(deployment.relayId)
  if (!relay) throw new Error("The network's node is unavailable")
  await relayRpc(
    relay,
    "tunnel.remove",
    { controlPlaneDeviceRemoved, id: deployment.id, mode },
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

function deploymentHostname(
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

function loadTailnetDefinitions() {
  return runAppEffect("tailnet.load", loadTailnetDefinitionsEffect())
}

function saveTailnetDefinition(definition: TailnetDefinition, ownerId: string) {
  return runAppEffect(
    "tailnet.save",
    saveTailnetDefinitionEffect(definition, ownerId)
  )
}

function loadTailnetCredential(id: string) {
  return runAppEffect(
    "tailnet.integration.load",
    loadTailnetCredentialEffect(id)
  )
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
  deployment: TunnelOverview
) {
  return runAppEffect(
    "tailscale.controlPlane.removeDevice",
    removeTailscaleControlPlaneDeviceEffect(credential, deployment)
  )
}

async function synchronizeTailscaleControlPlane(
  credential: TailscaleOAuthCredential,
  stack: TailnetOverview & { previousDomains?: ReadonlyArray<string> }
) {
  const result = await runAppEffect(
    "tailscale.controlPlane.sync",
    syncTailscaleControlPlaneEffect(credential, stack)
  )
  await recordTailscaleSync(stack.id, null)
  return result
}

function inspectTailscaleControlPlane(
  credential: TailscaleOAuthCredential,
  stack: TailnetOverview,
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
    "tailnet.integration.recordSync",
    recordTailnetSyncEffect(id, error)
  )
}

function replaceTailnetDefinition(
  definitions: ReadonlyArray<TailnetDefinition>,
  next: TailnetDefinition
): Array<TailnetDefinition> {
  return [
    ...definitions.filter((definition) => definition.id !== next.id),
    next,
  ]
}

function sameTailscaleBindings(
  bindings: ReadonlyArray<z.infer<typeof stackBindingInputSchema>>,
  deployments: ReadonlyArray<TunnelOverview>,
  relayIds: Iterable<string>
): boolean {
  const relays = new Set(relayIds)
  if (
    relays.size !== deployments.length ||
    deployments.some(({ relayId }) => !relays.has(relayId))
  ) {
    return false
  }
  const current = new Set(
    deployments.flatMap((deployment) =>
      deployment.bindings.map(
        (binding) =>
          `${deployment.relayId}:${binding.memberId}:${binding.enabled}`
      )
    )
  )
  return (
    current.size === bindings.length &&
    bindings.every((binding) =>
      current.has(`${binding.relayId}:${binding.memberId}:${binding.enabled}`)
    )
  )
}

// A TLD is unique across Kiln's tailnets.
function requireUnusedDomains(
  definitions: ReadonlyArray<TailnetDefinition>,
  id: string,
  domains: ReadonlyArray<string>
): void {
  for (const definition of definitions) {
    if (definition.id === id) continue
    const taken = domains.find((domain) => definition.domains.includes(domain))
    if (taken) {
      throw new Error(`.${taken} is already a TLD of ${definition.name}`)
    }
  }
}

function requireCompleteTunnelList(
  unavailableRelays: TailnetsResult["unavailableRelays"]
): void {
  if (unavailableRelays.length === 0) return
  const names = unavailableRelays.map(({ name }) => name).join(", ")
  throw new Error(
    `tailnets cannot be changed while these Relays are unavailable: ${names}`
  )
}

function tailscaleOverviewForDeployments(
  definition: TailnetDefinition,
  deployments: ReadonlyArray<TunnelOverview>,
  previousDomains?: ReadonlyArray<string>
): TailnetOverview & { previousDomains?: ReadonlyArray<string> } {
  // Tailscale is told its routes and TLDs, never its members' names.
  return {
    ...definition,
    access: { manage: true, tunnels: {} },
    names: [],
    bindings: deployments.flatMap(({ bindings, relayId, relayName }) =>
      bindings.map((binding) => ({
        ...binding,
        label: "",
        relayId,
        relayName,
      }))
    ),
    deployments: [...deployments],
    ...(previousDomains ? { previousDomains } : {}),
  }
}

async function restoreTailscaleControlPlane(
  credential: TailscaleOAuthCredential,
  definition: TailnetDefinition,
  deployments: ReadonlyArray<TunnelOverview>
): Promise<void> {
  await runAppEffect(
    "tailscale.controlPlane.restore",
    syncTailscaleControlPlaneEffect(
      credential,
      tailscaleOverviewForDeployments(definition, deployments)
    )
  )
}

async function reconcileTailscaleDomainAfterDefinitionFailure(
  credential: TailscaleOAuthCredential,
  failedDefinition: TailnetDefinition,
  relays: ReadonlyArray<PersistedRelay>
): Promise<TailnetDefinition | null> {
  // The losing request may already have replaced this split-DNS entry. Clear
  // it on that tailnet before restoring whichever network actually won the
  // database uniqueness race.
  await runAppEffect(
    "tailscale.controlPlane.domain.clearAfterDefinitionFailure",
    syncTailscaleControlPlaneEffect(
      credential,
      tailscaleOverviewForDeployments(failedDefinition, [])
    )
  )

  const [definitions, current] = await Promise.all([
    loadTailnetDefinitions(),
    loadTunnels(relays),
  ])
  requireCompleteTunnelList(current.unavailableRelays)
  const owner =
    definitions.find(
      (definition) =>
        definition.id !== failedDefinition.id &&
        definition.domains.some((domain) =>
          failedDefinition.domains.includes(domain)
        )
    ) ?? null
  if (!owner) return null

  // Clearing the losing request's tailnet is sufficient when the database
  // owner is not integrated. Never use one network's `/tailnet/-` credential
  // to modify another network's DNS or routes.
  if (!owner.integration) return owner
  const ownerCredential = await loadTailnetCredential(owner.id)
  await synchronizeTailscaleControlPlane(
    ownerCredential,
    tailscaleOverviewForDeployments(
      owner,
      current.deployments.filter(
        (deployment) => deployment.tailnetId === owner.id
      )
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
