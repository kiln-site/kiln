import { createHash } from "node:crypto"

import { createServerFn } from "@tanstack/react-start"
import {
  appTailscaleMember,
  databaseTailscaleMember,
  MAXIMUM_TUNNEL_BINDINGS,
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
  saveTailnetDefinitionEffect,
  type TailscaleIntegration,
  type TailnetDefinition,
  type TailscaleOAuthCredential,
} from "@/effect/tailnets"
import { reserveInstanceId } from "@/effect/instance-ids"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import { listManagedDatabaseRecordsEffect } from "@/effect/managed-databases"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin } from "@/lib/access-control"
import { invalidateRelayCache, relayCachePolicy } from "@/lib/relay-client"
import { relayRpc } from "@/lib/relay-connection"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { startTailnetDeletion } from "@/lib/tailnet-deletion.server"
import { writeTailnetDns } from "@/lib/tunnel-dns.server"
import { tailscaleMemberProblem } from "@/lib/tailscale-members"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  tailnetKey,
  tailnetSettingsKey,
} from "@/lib/tunnel-lanes"
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
  hostname: relayTailscaleSubdomainSchema,
  // A game server or an App's service (see `tailscaleMemberIdSchema`).
  memberId: tailscaleMemberIdSchema,
  relayId: relayIdSchema,
})

const tailscaleClientSecretSchema = z.string().trim().min(20).max(512)

const saveTailnetSchema = z.strictObject({
  authKey: relayTailscaleAuthKeySchema.optional(),
  bindings: z
    .array(stackBindingInputSchema)
    .max(MAXIMUM_TUNNEL_BINDINGS),
  domain: relayTailscaleDomainSchema,
  id: tunnelIdSchema,
  name: relayInstanceNameSchema,
})

const createTailnetSchema = z.strictObject({
  clientId: z.string().trim().min(1).max(120),
  clientSecret: tailscaleClientSecretSchema,
  domain: relayTailscaleDomainSchema,
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
  domain: relayTailscaleDomainSchema,
  id: tunnelIdSchema,
  previousDomain: relayTailscaleDomainSchema,
  tag: z
    .string()
    .trim()
    .transform((value) => (value.startsWith("tag:") ? value : `tag:${value}`))
    .pipe(z.string().regex(/^tag:[a-zA-Z0-9][a-zA-Z0-9-]*$/u)),
})

const previewTailscaleIntegrationSchema = configureTailscaleIntegrationSchema
  .omit({ previousDomain: true })
  .extend({ clientSecret: tailscaleClientSecretSchema })

const syncTailscaleIntegrationSchema = z.strictObject({
  id: tunnelIdSchema,
})

export interface TunnelOverview extends Tunnel {
  relayId: string
  relayName: string
}

export interface TailnetOverview {
  bindings: Array<{
    address: string
    enabled: boolean
    hostname: string
    memberId: string
    relayId: string
    relayName: string
  }>
  deployments: Array<TunnelOverview>
  cleanup: TailnetDefinition["cleanup"]
  domain: string
  id: string
  integration: TailscaleIntegration | null
  name: string
}

export interface TailnetsResult {
  stacks: Array<TailnetOverview>
  unavailableRelays: Array<{
    id: string
    message: string
    name: string
  }>
}

export const getTailnets = createServerFn({ method: "GET" }).handler(
  async () => {
    await requireTailscaleAdministrator()
    return loadTailnets()
  }
)

const createTailnetOperation = operation<
  z.infer<typeof createTailnetSchema> & { id: string }
>()({
  name: "tailscale.network.create",
  doing: "Creating this Tailscale network",
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
  const domainOwner = definitions.find(
    (definition) => definition.domain === data.domain
  )
  if (domainOwner) {
    throw new Error(
      `Network TLD .${data.domain} is already used by ${domainOwner.name}`
    )
  }
  const verified = await runAppEffect(
    "tailscale.oauth.verify",
    verifyTailscaleOAuthCredentialEffect(data.clientId, data.clientSecret, [
      data.tag,
    ])
  )
  await runAppEffect(
    "tailscale.networks.create",
    createTailnetDefinitionEffect(
      {
        domain: data.domain,
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
  name: "tailscale.network.connect",
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
  if (!definition) throw new Error("Tailscale network not found")
  // Its removal still needs the credentials it was set up with.
  if (definition.cleanup) {
    throw new Error("This Tailscale network is being removed")
  }
  const clientSecret =
    data.clientSecret ??
    (await loadTailnetCredential(data.id)).clientSecret
  const verified = await runAppEffect(
    "tailscale.oauth.verify",
    verifyTailscaleOAuthCredentialEffect(data.clientId, clientSecret, [
      data.tag,
    ])
  )
  await runAppEffect(
    "tailscale.networks.integration.save",
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
      if (!stack) throw new Error("Tailscale network not found")
      if (stack.domain !== data.domain) {
        throw new Error("The network domain changed before setup completed")
      }
      await synchronizeTailscaleControlPlane(credential, {
        ...stack,
        previousDomain: data.previousDomain,
      })
      const inspection = await inspectTailscaleControlPlane(
        credential,
        stack,
        data.previousDomain
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
    if (!stack) throw new Error("Tailscale network not found")
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
        { ...stack, domain: data.domain },
        stack.domain
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
    if (!stack) throw new Error("Tailscale network not found")
    return {
      inspection: await inspectTailscaleControlPlane(credential, stack),
      stacks: result,
    }
  })

const syncTailscaleIntegrationOperation = operation<
  z.infer<typeof syncTailscaleIntegrationSchema>
>()({
  name: "tailscale.network.sync",
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
  if (!stack) throw new Error("Tailscale network not found")
  // Its removal takes its nodes away; a sync would point DNS back at them.
  if (stack.cleanup) throw new Error("This Tailscale network is being removed")
  const synchronized = await Effect.runPromise(
    promiseEffect(async () => {
      await synchronizeTailscaleControlPlane(credential, stack)
      return loadTailnets()
    }).pipe(Effect.tapError(recordTailscaleSyncFailure(data.id)))
  )
  publishTailscaleChange()
  return synchronized
}

const saveTailnetOperation = operation<
  z.infer<typeof saveTailnetSchema>
>()({
  name: "tailscale.network.save",
  doing: "Saving this Tailscale network",
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
  const duplicateHostname = data.bindings.find(
    (binding, index, bindings) =>
      bindings.findIndex(
        (candidate) => candidate.hostname === binding.hostname
      ) !== index
  )
  if (duplicateHostname) {
    throw new Error(
      `Hostname ${duplicateHostname.hostname}.${data.domain} is selected more than once`
    )
  }

  const grouped = new Map<string, typeof data.bindings>()
  for (const binding of data.bindings) {
    const relay = relayById.get(binding.relayId)
    if (!relay) throw new Error("A selected server's node is unavailable")
    const relayBindings = grouped.get(binding.relayId) ?? []
    relayBindings.push(binding)
    grouped.set(binding.relayId, relayBindings)
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
  if (!definition) throw new Error("Tailscale network not found")
  if (
    !definition.integration &&
    !sameTailscaleBindings(data.bindings, currentForStack)
  ) {
    throw new Error(
      "Connect this network to Tailscale before assigning servers"
    )
  }
  if (definition.cleanup) {
    throw new Error("This Tailscale network is being removed")
  }
  const currentRelayIds = new Set(currentForStack.map(({ relayId }) => relayId))
  const domainOwner = definitions.find(
    (candidate) => candidate.id !== id && candidate.domain === data.domain
  )
  if (domainOwner) {
    throw new Error(
      `Network TLD .${data.domain} is already used by ${domainOwner.name}`
    )
  }
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
      throw new Error("A selected server's node is unavailable")
    }
    const problem = tailscaleMemberProblem(binding, {
      apps: appRecords,
      databases: databaseRecords,
      instances: snapshot.instances,
    })
    if (problem) throw new Error(problem)
  }

  const nextDefinition = {
    cleanup: definition.cleanup,
    domain: data.domain,
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
        if (!relay) throw new Error("A selected server's node is unavailable")
        return {
          bindings: bindings.map(({ enabled, hostname, memberId }) => ({
            enabled,
            hostname,
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
      domain: data.domain,
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
                  definition.domain
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
                      definition?.domain !== nextDefinition.domain
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
                      `Network TLD .${nextDefinition.domain} is already used by ${domainOwnerAfterConflict.name}`,
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
  publishTailscaleChange()
  return {
    stacks: groupTunnels(
      [
        ...current.filter((deployment) => deployment.tailnetId !== id),
        ...synchronized,
      ],
      replaceTailnetDefinition(definitions, nextDefinition)
    ),
    unavailableRelays: currentResult.unavailableRelays,
  }
}

const removeTailnetOperation = operation<
  z.infer<typeof removeTailnetSchema>
>()({
  name: "tailscale.network.remove",
  doing: "Removing this Tailscale network",
  authorize: ({ user }) => tailscaleAdministrator(user),
  locks: ({ input }) => [exclusive(tailnetKey(input.id))],
  run: ({ context: user, input }) =>
    promiseEffect(() => removeTailnetHandler(user, input)),
  audit: ({ input }) => ({ id: input.id, kind: "tailnet" }),
})

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
  if (!definition) throw new Error("Tailscale network not found")
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
    stacks: groupTunnels(result.deployments, definitions),
    unavailableRelays: result.unavailableRelays,
  }
}

function groupTunnels(
  deployments: ReadonlyArray<TunnelOverview>,
  definitions: ReadonlyArray<TailnetDefinition>
): Array<TailnetOverview> {
  const grouped = new Map<string, TailnetOverview>()
  for (const definition of definitions) {
    grouped.set(definition.id, {
      ...definition,
      bindings: [],
      deployments: [],
    })
  }
  for (const deployment of deployments) {
    const stack = grouped.get(deployment.tailnetId) ?? {
      bindings: [],
      cleanup: null,
      deployments: [],
      domain: deployment.domain,
      id: deployment.tailnetId,
      integration: null,
      name: deployment.name,
    }
    stack.deployments.push(deployment)
    stack.bindings.push(
      ...deployment.bindings.map((binding) => ({
        ...binding,
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

async function loadTunnels(
  relays: ReadonlyArray<PersistedRelay>
): Promise<{
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
        await relayRpc(
          relay,
          "tunnel.apply",
          input,
          240_000,
          subject
        )
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
  return runAppEffect(
    "tailscale.networks.load",
    loadTailnetDefinitionsEffect()
  )
}

function saveTailnetDefinition(
  definition: TailnetDefinition,
  ownerId: string
) {
  return runAppEffect(
    "tailscale.networks.save",
    saveTailnetDefinitionEffect(definition, ownerId)
  )
}

function loadTailnetCredential(id: string) {
  return runAppEffect(
    "tailscale.networks.integration.load",
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
  stack: TailnetOverview & { previousDomain?: string }
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
  previousDomain?: string
) {
  return runAppEffect(
    "tailscale.controlPlane.inspect",
    inspectTailscaleControlPlaneEffect(credential, {
      ...stack,
      previousDomain,
    })
  )
}

function recordTailscaleSync(id: string, error: string | null) {
  return runAppEffect(
    "tailscale.networks.integration.recordSync",
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
  deployments: ReadonlyArray<TunnelOverview>
): boolean {
  const current = new Set(
    deployments.flatMap((deployment) =>
      deployment.bindings.map(
        (binding) =>
          `${deployment.relayId}:${binding.memberId}:${binding.hostname}:${binding.enabled}`
      )
    )
  )
  return (
    current.size === bindings.length &&
    bindings.every((binding) =>
      current.has(
        `${binding.relayId}:${binding.memberId}:${binding.hostname}:${binding.enabled}`
      )
    )
  )
}

function requireCompleteTunnelList(
  unavailableRelays: TailnetsResult["unavailableRelays"]
): void {
  if (unavailableRelays.length === 0) return
  const names = unavailableRelays.map(({ name }) => name).join(", ")
  throw new Error(
    `Tailscale networks cannot be changed while these Relays are unavailable: ${names}`
  )
}

function tailscaleOverviewForDeployments(
  definition: TailnetDefinition,
  deployments: ReadonlyArray<TunnelOverview>,
  previousDomain?: string
): TailnetOverview & { previousDomain?: string } {
  return {
    ...definition,
    bindings: deployments.flatMap(({ bindings, relayId, relayName }) =>
      bindings.map((binding) => ({
        ...binding,
        relayId,
        relayName,
      }))
    ),
    deployments: [...deployments],
    ...(previousDomain ? { previousDomain } : {}),
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
        definition.domain === failedDefinition.domain
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
