import type { RelayInstance } from "@workspace/contracts"
import {
  builtinTailscaleBrickId,
  relayInstanceSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect, Semaphore } from "effect"
import { z } from "zod"

import {
  cloudflareAddressRecord,
  cloudflareHostnameAvailableEffect,
  createCloudflareAddressRecordEffect,
  createCloudflareSrvRecordEffect,
  deleteCloudflareRecordEffect,
  replaceCloudflareAddressRecordEffect,
  resolveCloudflareZoneEffect,
  updateCloudflareAddressRecordEffect,
  updateCloudflareSrvRecordEffect,
} from "@/effect/cloudflare-api"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import {
  activateInstanceDomainAssignmentEffect,
  deleteInstanceDomainAssignmentEffect,
  deleteRelayInstanceDomainAssignmentsEffect,
  loadActiveInstanceDomainAssignmentsEffect,
  loadCloudflareIntegrationCredentialEffect,
  loadDomainIntegrationEffect,
  loadInstanceDomainAssignmentsEffect,
  loadInstanceDomainAssignmentEffect,
  loadInstanceDomainOptOutEffect,
  loadRelayInstanceDomainAssignmentsEffect,
  loadUsedVanityLabelsEffect,
  recordInstanceDomainErrorEffect,
  recordInstanceDomainSyncErrorEffect,
  reserveInstanceDomainAssignmentEffect,
  saveCloudflareIntegrationEffect,
  setInstanceDomainOptOutEffect,
  updateInstanceDomainAddressRecordEffect,
  updateInstanceDomainEndpointEffect,
  updateInstanceDomainLabelEffect,
  type CloudflareIntegrationCredential,
  type InstanceDomainAssignment,
} from "@/effect/domains"
import { ExternalServiceError } from "@/effect/errors"
import { runAppEffect } from "@/effect/runtime"
import { isPlatformAdmin, requireRelayPermission } from "@/lib/access-control"
import {
  invalidateCached,
  readThroughCache,
  type CachePolicy,
} from "@/lib/cache"
import {
  domainHasActiveSrvRecord,
  hostPortAddress,
  managedDomainConnectAddress,
  managedDomainEndpointMatches,
} from "@/lib/domain-address"
import {
  validateBlacklistPatterns,
  vanityLabelAllowed,
} from "@/lib/domain-schemas"
import { publishDomainChange } from "@/lib/domain-realtime.server"
import { kilnRootDomain } from "@/lib/environment"
import { listInstanceDirectoryEffect } from "@/lib/instance-directory"
import { relayInstanceRouteId, type FleetRelayInstance } from "@/lib/relay-fleet"
import type { PersistedRelay } from "@/lib/relay-registry"
import { listPersistedRelays } from "@/lib/relay-registry"
import { relayJsonEffect } from "@/lib/relay-client"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  generateVanityCandidates,
  managedDomainSrvConfiguration,
} from "@/server/vanity-names"
import type {
  ConfigureDomainInput,
  InstanceDomainInput,
  InstanceDomainOverview,
  ManagedDomainOverview,
  SetVanityInput,
} from "@/server/domains"

const managedDomainAddressCachePolicy: CachePolicy = {
  key: "domains:assignments:active-addresses",
  name: "Managed domain addresses",
  ttlMs: 30_000,
}
const managedDomainAddressMapSchema = z.record(
  z.string(),
  z.object({
    address: z.string(),
    publicHost: z.string(),
    publicPort: z.number().int().min(1).max(65_535),
  })
)
const invalidateManagedDomainAddressesEffect = invalidateCached(
  managedDomainAddressCachePolicy
)

// Provisioning, renaming, and removing a game server's domain each read its
// assignment and then change Cloudflare records. One permit per game server
// keeps a removal from landing between a provision's checks and its writes.
// Hearth runs one application process, so a process-local lock is enough.
const instanceDomainLocks = new Map<string, Semaphore.Semaphore>()

function withInstanceDomainLock<A, E, R>(
  relayId: string,
  instanceId: string,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  const key = assignmentKey(relayId, instanceId)
  let lock = instanceDomainLocks.get(key)
  if (!lock) {
    lock = Semaphore.makeUnsafe(1)
    instanceDomainLocks.set(key, lock)
  }
  return lock.withPermit(effect)
}

export async function getDomainSettingsHandler() {
  await requireDomainAdministrator()
  // Hearth's own tables only, so the page never waits on a Relay.
  const [integration, assignments, relays, directory] = await Promise.all([
    runAppEffect("domains.integration.load", loadDomainIntegrationEffect()),
    runAppEffect(
      "domains.assignments.all",
      loadInstanceDomainAssignmentsEffect()
    ),
    listPersistedRelays(),
    runAppEffect("instances.directory.list", listInstanceDirectoryEffect()),
  ])
  const relayNames = new Map(relays.map((relay) => [relay.id, relay.name]))
  const servers = new Map(
    directory.map((record) => [assignmentKey(record.relayId, record.id), record])
  )
  // Match the Game Servers table: a short ID routes on its own unless another
  // game server shares it.
  const shortIdCounts = new Map<string, number>()
  for (const record of directory) {
    if (record.brickId === builtinTailscaleBrickId) continue
    const shortId = record.id.slice(0, 8)
    shortIdCounts.set(shortId, (shortIdCounts.get(shortId) ?? 0) + 1)
  }
  const managedDomains = assignments.map(
    (assignment): ManagedDomainOverview => {
      const server = servers.get(
        assignmentKey(assignment.relayId, assignment.instanceId)
      )
      const shortId = assignment.instanceId.slice(0, 8)
      return {
        address: managedDomainConnectAddress(assignment),
        domain: assignment.domain,
        instanceId: assignment.instanceId,
        lastError: assignment.lastError,
        port: assignment.publicPort,
        relayId: assignment.relayId,
        relayName: relayNames.get(assignment.relayId) ?? "Unknown Relay",
        server: {
          brickId: server?.brickId,
          game: server?.game,
          implementation: server?.implementation,
          name: server?.name ?? shortId,
          // Otherwise the Relay-qualified full ID, which names exactly one
          // server even where short IDs collide or the server is missing
          // from the directory.
          routeId:
            server && shortIdCounts.get(shortId) === 1
              ? shortId
              : relayInstanceRouteId(assignment.relayId, assignment.instanceId),
        },
        srvActive: domainHasActiveSrvRecord(assignment),
        status: assignment.status,
        supportsSrv: assignment.supportsSrv,
        vanityLabel: assignment.vanityLabel,
      }
    }
  )
  return {
    hearthDomain: kilnRootDomain(),
    integration,
    managedDomains,
    managedServerCount: managedDomains.length,
  }
}

export async function configureDomainIntegrationHandler(
  data: ConfigureDomainInput
) {
  await requireDomainAdministrator()
  const blacklistPatterns = validateBlacklistPatterns(data.blacklistPatterns)
  const existing = await runAppEffect(
    "domains.integration.load",
    loadDomainIntegrationEffect()
  )
  if (existing && existing.domain !== data.domain) {
    const usedLabels = await runAppEffect(
      "domains.assignments.usedLabels",
      loadUsedVanityLabelsEffect(existing.domain)
    )
    if (usedLabels.size > 0) {
      throw new Error(
        "The vanity domain cannot change while managed server records exist"
      )
    }
  }
  const apiToken =
    data.apiToken ??
    (
      await recoverPromise(
        () =>
          runAppEffect(
            "domains.integration.credential",
            loadCloudflareIntegrationCredentialEffect()
          ),
        () => null
      )
    )?.apiToken
  if (!apiToken) throw new Error("Enter a Cloudflare API token")
  const zone = await runAppEffect(
    "cloudflare.zone.resolve",
    resolveCloudflareZoneEffect(apiToken, data.domain)
  )
  await runAppEffect(
    "domains.integration.save",
    saveCloudflareIntegrationEffect({
      apiToken,
      blacklistPatterns,
      domain: data.domain,
      enabled: data.enabled,
      zoneId: zone.id,
      zoneName: zone.name,
    }).pipe(Effect.andThen(invalidateManagedDomainAddressesEffect))
  )
  return {
    integration: await runAppEffect(
      "domains.integration.load",
      loadDomainIntegrationEffect()
    ),
  }
}

export async function resyncDomainAssignmentsHandler() {
  await requireDomainAdministrator()
  const integration = await runAppEffect(
    "domains.integration.load",
    loadDomainIntegrationEffect()
  )
  if (!integration?.enabled) {
    throw new Error("Enable automatic vanity provisioning before syncing")
  }

  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  const snapshots = await Promise.all(
    relays.map(async (relay) => ({
      relay,
      snapshot: relaySnapshotSchema.parse(
        await runAppEffect(
          "relay.snapshot.domains.resync",
          relayJsonEffect(relay, "/v1/snapshot", (input) => input)
        )
      ),
    }))
  )
  const instances = snapshots.flatMap(({ relay, snapshot }) =>
    snapshot.instances.map((instance) => ({ ...instance, relayId: relay.id }))
  )
  const [, failures] = await runAppEffect(
    "domains.instances.resync",
    Effect.partition(instances, provisionInstanceDomainEffect, {
      concurrency: 1,
    })
  )
  if (failures.length > 0) {
    const reason = failures[0]
    throw new Error(
      `Could not sync ${failures.length} of ${instances.length} server addresses: ${
        reason instanceof Error ? reason.message : "Cloudflare sync failed"
      }`
    )
  }
  return { syncedServerCount: instances.length }
}

export async function getInstanceDomainHandler(data: InstanceDomainInput) {
  const user = await requireEligibleResourceUser()
  await requireRelayPermission({
    instanceId: data.instanceId,
    permission: "instance.network.read",
    relayId: data.relayId,
    user,
  })
  const [assignment, integration] = await Promise.all([
    runAppEffect(
      "domains.assignment.load",
      loadInstanceDomainAssignmentEffect(data.relayId, data.instanceId)
    ),
    runAppEffect("domains.integration.load", loadDomainIntegrationEffect()),
  ])
  return {
    assignment: assignment ? assignmentOverview(assignment) : null,
    managedDomain: integration?.enabled === true ? integration.domain : null,
  }
}

/**
 * Removes a game server's vanity address and keeps it removed: starts, port
 * changes, and Sync skip the server until a vanity name is set again.
 */
export async function removeInstanceDomainHandler(data: InstanceDomainInput) {
  await requireDomainAdministrator()
  // A failed removal still changes the row, so publish either way.
  await ensuringPromise(
    () =>
      runAppEffect(
        "domains.instance.remove",
        removeInstanceDomainEffect(data.relayId, data.instanceId)
      ),
    () => publishDomainChange(data)
  )
}

export async function setInstanceVanityHandler(data: SetVanityInput) {
  const { instance } = await loadWritableInstance(data.relayId, data.instanceId)
  // A failed rename can still clear leftover records, so publish either way.
  return ensuringPromise(
    () =>
      runAppEffect(
        "domains.instance.setVanity",
        withInstanceDomainLock(
          data.relayId,
          data.instanceId,
          setInstanceVanityEffect(
            { ...instance, relayId: data.relayId },
            data.vanityLabel
          ).pipe(
            // Choosing a name again undoes a removal.
            Effect.tap(() =>
              setInstanceDomainOptOutEffect(
                data.relayId,
                data.instanceId,
                false
              )
            )
          )
        )
      ),
    () => publishDomainChange(data)
  )
}

export async function provisionInstanceDomainBestEffort(
  instance: RelayInstance,
  relayId: string
): Promise<void> {
  const provisioned = await runAppEffect(
    "domains.instance.provision",
    provisionInstanceDomainEffect({ ...instance, relayId }).pipe(
      Effect.map((assignment) => assignment !== null),
      Effect.catch((cause) =>
        Effect.sync(() => {
          console.warn(
            `[Kiln Domains] Server ${instance.id} was provisioned, but its vanity address could not be created:`,
            cause
          )
          return false
        })
      )
    )
  )
  if (provisioned) publishDomainChange({ instanceId: instance.id, relayId })
}

export async function provisionInstanceDomain(
  instance: RelayInstance,
  relayId: string
): Promise<void> {
  const provisioned = await runAppEffect(
    "domains.instance.provision",
    provisionInstanceDomainEffect({ ...instance, relayId }).pipe(
      Effect.map((assignment) => assignment !== null)
    )
  )
  if (provisioned) publishDomainChange({ instanceId: instance.id, relayId })
}

export const applyManagedDomainAddressesEffect = Effect.fn(
  "domains.assignments.apply"
)(function* (instances: Array<FleetRelayInstance>) {
  if (instances.length === 0) return instances
  const addresses = yield* loadManagedDomainAddressesEffect()
  return instances.map((instance) => ({
    ...instance,
    connectAddress: instance.tailscale.enabled
      ? instance.connectAddress
      : managedAddressForInstance(addresses, instance),
  }))
})

export const loadManagedDomainAddressesEffect = Effect.fn(
  "domains.assignments.cachedAddresses"
)(function* () {
  return yield* readThroughCache({
    decode: managedDomainAddressMapSchema.parse,
    load: loadActiveInstanceDomainAssignmentsEffect().pipe(
      Effect.map((assignments) =>
        Object.fromEntries(
          assignments.map((assignment) => [
            assignmentKey(assignment.relayId, assignment.instanceId),
            {
              address: managedDomainConnectAddress(assignment),
              publicHost: assignment.publicHost,
              publicPort: assignment.publicPort,
            },
          ])
        )
      )
    ),
    policy: managedDomainAddressCachePolicy,
  })
})

// A removal stays recorded here: the game server may survive a failed
// deletion. Post-delete cleanup clears it once the Relay has removed it.
export const deleteInstanceDomainEffect = Effect.fn("domains.instance.delete")(
  function* (relayId: string, instanceId: string) {
    const assignment = yield* loadInstanceDomainAssignmentEffect(
      relayId,
      instanceId
    )
    if (!assignment) return
    yield* deleteAssignmentRecordsEffect(assignment)
  },
  (effect, relayId, instanceId) =>
    withInstanceDomainLock(relayId, instanceId, effect)
)

export const removeInstanceDomainEffect = Effect.fn("domains.instance.remove")(
  function* (relayId: string, instanceId: string) {
    yield* setInstanceDomainOptOutEffect(relayId, instanceId, true)
    const assignment = yield* loadInstanceDomainAssignmentEffect(
      relayId,
      instanceId
    )
    if (!assignment) return
    yield* deleteAssignmentRecordsEffect(assignment).pipe(
      // Keep the removal. Cloudflare deletes are idempotent, so deleting
      // again finishes it; until then the domain shows as failed and Hearth
      // stops advertising it.
      Effect.tapError((error) =>
        recordInstanceDomainErrorEffect(
          relayId,
          instanceId,
          `Delete failed: ${error.message}`
        ).pipe(
          Effect.andThen(invalidateManagedDomainAddressesEffect),
          Effect.ignore
        )
      )
    )
  },
  (effect, relayId, instanceId) =>
    withInstanceDomainLock(relayId, instanceId, effect)
)

// A failed provision or removal can leave records behind an assignment that
// isn't active. Delete them before choosing a name again, so the new records
// don't orphan them and they don't make the game server's own name look taken.
const releaseStaleRecordsEffect = Effect.fn("domains.instance.releaseStale")(
  function* (
    assignment: InstanceDomainAssignment,
    credential: CloudflareIntegrationCredential
  ) {
    if (!assignment.addressRecordId && !assignment.srvRecordId) return
    yield* deleteManagedDomainAssignmentEffect(assignment, credential)
  }
)

const deleteAssignmentRecordsEffect = Effect.fn(
  "domains.instance.deleteRecords"
)(function* (assignment: InstanceDomainAssignment) {
  const hasManagedRecords = Boolean(
    assignment.addressRecordId || assignment.srvRecordId
  )
  const credential = hasManagedRecords
    ? yield* loadCloudflareIntegrationCredentialEffect()
    : null
  yield* deleteManagedDomainAssignmentEffect(assignment, credential)
})

export const deleteManagedDomainAssignmentEffect = Effect.fn(
  "domains.instance.deleteAssignment"
)(function* (
  assignment: InstanceDomainAssignment,
  credential: CloudflareIntegrationCredential | null
) {
  const recordIds = [assignment.addressRecordId, assignment.srvRecordId].filter(
    (recordId): recordId is string => recordId !== null
  )
  if (recordIds.length > 0 && !credential) {
    return yield* domainFailure(
      "Cloudflare credentials are required to remove this managed address"
    )
  }
  if (credential) {
    yield* Effect.all(
      recordIds.map((recordId) =>
        deleteCloudflareRecordEffect(
          credential.apiToken,
          credential.zoneId,
          recordId
        )
      ),
      { concurrency: "unbounded" }
    )
  }
  yield* deleteInstanceDomainAssignmentEffect(
    assignment.relayId,
    assignment.instanceId
  )
  yield* invalidateManagedDomainAddressesEffect
})

export const removeRelayManagedDomainsEffect = Effect.fn(
  "domains.relay.removeAssignments"
)(function* (relayId: string, removeCloudflareRecords: boolean) {
  const assignments = yield* loadRelayInstanceDomainAssignmentsEffect(relayId)
  const recordIds = assignments.flatMap((assignment) =>
    [assignment.addressRecordId, assignment.srvRecordId].filter(
      (recordId): recordId is string => recordId !== null
    )
  )
  if (removeCloudflareRecords && recordIds.length > 0) {
    const credential = yield* loadCloudflareIntegrationCredentialEffect()
    yield* Effect.all(
      recordIds.map((recordId) =>
        deleteCloudflareRecordEffect(
          credential.apiToken,
          credential.zoneId,
          recordId
        )
      ),
      { concurrency: "unbounded" }
    )
  }
  yield* deleteRelayInstanceDomainAssignmentsEffect(relayId)
  yield* invalidateManagedDomainAddressesEffect
  return assignments.length
})

const provisionInstanceDomainEffect = Effect.fn("domains.instance.provision")(
  function* (instance: RelayInstance & { relayId: string }) {
    const publicHost = instance.publicHost
    const publicPort = instance.publicPort
    if (!publicHost || !publicPort) return null
    const integration = yield* loadDomainIntegrationEffect()
    if (!integration?.enabled) return null
    if (yield* loadInstanceDomainOptOutEffect(instance.relayId, instance.id)) {
      return null
    }
    const credential = yield* loadCloudflareIntegrationCredentialEffect()
    const existing = yield* loadInstanceDomainAssignmentEffect(
      instance.relayId,
      instance.id
    )
    if (existing?.status === "active") {
      const srvConfiguration = managedDomainSrvConfiguration(instance)
      if (
        managedDomainEndpointMatches(existing, instance) &&
        domainSrvConfigurationMatches(existing, srvConfiguration)
      ) {
        return assignmentOverview(existing)
      }
      const synced = yield* syncVanityEndpointEffect(
        credential,
        existing,
        instance
      ).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
      return assignmentOverview(synced)
    }
    if (existing) yield* releaseStaleRecordsEffect(existing, credential)
    const generated = generateVanityCandidates(credential.blacklistPatterns)
    const candidates = existing
      ? [...new Set([existing.vanityLabel, ...generated])]
      : generated
    const vanityLabel = yield* availableVanityLabelEffect(
      credential,
      candidates,
      assignmentOwner(instance)
    )
    return yield* provisionVanityRecordsEffect(
      credential,
      instance,
      vanityLabel
    ).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
  },
  (effect, instance) =>
    withInstanceDomainLock(instance.relayId, instance.id, effect)
)

const setInstanceVanityEffect = Effect.fn("domains.instance.setVanity")(
  function* (
    instance: RelayInstance & { relayId: string },
    vanityLabel: string
  ) {
    const publicHost = instance.publicHost
    const publicPort = instance.publicPort
    if (!publicHost || !publicPort) {
      return yield* domainFailure(
        "Update this Relay before assigning a vanity address"
      )
    }
    const credential = yield* loadCloudflareIntegrationCredentialEffect()
    if (!credential.enabled) {
      return yield* domainFailure(
        "Managed domains are disabled by the platform administrator"
      )
    }
    if (!vanityLabelAllowed(vanityLabel, credential.blacklistPatterns)) {
      return yield* domainFailure(
        "That server address is reserved by the platform administrator"
      )
    }
    const assignment = yield* loadInstanceDomainAssignmentEffect(
      instance.relayId,
      instance.id
    )
    if (!assignment || assignment.status !== "active") {
      if (assignment) yield* releaseStaleRecordsEffect(assignment, credential)
      const available = yield* availableVanityLabelEffect(
        credential,
        [vanityLabel],
        assignmentOwner(instance)
      )
      return yield* provisionVanityRecordsEffect(
        credential,
        instance,
        available
      ).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
    }
    const current = managedDomainEndpointMatches(assignment, instance)
      ? assignment
      : yield* syncVanityEndpointEffect(credential, assignment, instance).pipe(
          Effect.ensuring(invalidateManagedDomainAddressesEffect)
        )
    if (current.vanityLabel === vanityLabel) {
      return assignmentOverview(current)
    }
    yield* assertVanityAvailableEffect(credential, vanityLabel)
    return yield* renameVanityRecordsEffect(
      credential,
      current,
      vanityLabel
    ).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
  }
)

const provisionVanityRecordsEffect = Effect.fn(
  "domains.instance.createRecords"
)(function* (
  credential: CloudflareIntegrationCredential,
  instance: RelayInstance & { relayId: string },
  vanityLabel: string
) {
  const publicHost = instance.publicHost
  const publicPort = instance.publicPort
  if (!publicHost || !publicPort) {
    return yield* domainFailure("The Relay did not report a public endpoint")
  }
  const srvConfiguration = managedDomainSrvConfiguration(instance)
  const supportsSrv = srvConfiguration !== null
  const srvProtocol = srvConfiguration?.protocol ?? null
  const srvService = srvConfiguration?.service ?? null
  yield* reserveInstanceDomainAssignmentEffect({
    domain: credential.domain,
    instanceId: instance.id,
    publicHost,
    publicPort,
    relayId: instance.relayId,
    srvProtocol,
    srvService,
    supportsSrv,
    vanityLabel,
  })
  const hostname = `${vanityLabel}.${credential.domain}`
  const address = cloudflareAddressRecord(hostname, publicHost)
  const addressRecord = yield* createCloudflareAddressRecordEffect(
    credential.apiToken,
    credential.zoneId,
    address,
    instance.id
  ).pipe(
    Effect.tapError((error) =>
      recordInstanceDomainErrorEffect(
        instance.relayId,
        instance.id,
        error.message
      )
    )
  )
  const srvRecord =
    supportsSrv && srvProtocol && srvService
      ? yield* createCloudflareSrvRecordEffect(
          credential.apiToken,
          credential.zoneId,
          srvRecordInput(
            hostname,
            publicPort,
            srvService,
            srvProtocol,
            address.type === "CNAME" ? publicHost : hostname
          ),
          instance.id
        ).pipe(
          Effect.catch((error) =>
            deleteCloudflareRecordEffect(
              credential.apiToken,
              credential.zoneId,
              addressRecord.id
            ).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(
                recordInstanceDomainErrorEffect(
                  instance.relayId,
                  instance.id,
                  error.message
                )
              ),
              Effect.andThen(Effect.fail(error))
            )
          )
        )
      : null
  yield* activateInstanceDomainAssignmentEffect({
    addressRecordId: addressRecord.id,
    addressRecordType: address.type,
    instanceId: instance.id,
    relayId: instance.relayId,
    srvRecordId: srvRecord?.id ?? null,
  }).pipe(
    Effect.catch((error) =>
      Effect.all([
        deleteCloudflareRecordEffect(
          credential.apiToken,
          credential.zoneId,
          addressRecord.id
        ).pipe(Effect.catch(() => Effect.void)),
        srvRecord
          ? deleteCloudflareRecordEffect(
              credential.apiToken,
              credential.zoneId,
              srvRecord.id
            ).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ]).pipe(
        Effect.andThen(
          recordInstanceDomainErrorEffect(
            instance.relayId,
            instance.id,
            error.message
          )
        ),
        Effect.andThen(Effect.fail(error))
      )
    )
  )
  const assignment = yield* loadInstanceDomainAssignmentEffect(
    instance.relayId,
    instance.id
  )
  if (!assignment) {
    return yield* domainFailure("The vanity address could not be saved")
  }
  return assignmentOverview(assignment)
})

const syncVanityEndpointEffect = Effect.fn("domains.instance.syncEndpoint")(
  function* (
    credential: CloudflareIntegrationCredential,
    assignment: InstanceDomainAssignment,
    instance: RelayInstance & { relayId: string }
  ) {
    const addressRecordId = assignment.addressRecordId
    const publicHost = instance.publicHost
    const publicPort = instance.publicPort
    if (!addressRecordId) {
      return yield* domainFailure(
        "The managed address is missing its Cloudflare record"
      )
    }
    if (!publicHost || !publicPort) {
      return yield* domainFailure("The Relay did not report a public endpoint")
    }
    const hostname = `${assignment.vanityLabel}.${assignment.domain}`
    const address = cloudflareAddressRecord(hostname, publicHost)
    const srvConfiguration = managedDomainSrvConfiguration(instance)
    const sync = Effect.gen(function* () {
      if (assignment.addressRecordType === address.type) {
        yield* updateCloudflareAddressRecordEffect(
          credential.apiToken,
          credential.zoneId,
          addressRecordId,
          address,
          assignment.instanceId
        )
      } else {
        const replacement = yield* replaceCloudflareAddressRecordEffect(
          credential.apiToken,
          credential.zoneId,
          addressRecordId,
          address,
          assignment.instanceId
        )
        yield* updateInstanceDomainAddressRecordEffect({
          addressRecordId: replacement.id,
          addressRecordType: address.type,
          instanceId: assignment.instanceId,
          relayId: assignment.relayId,
        })
      }
      const nextSrvRecordId = srvConfiguration
        ? assignment.srvRecordId
          ? (yield* updateCloudflareSrvRecordEffect(
              credential.apiToken,
              credential.zoneId,
              assignment.srvRecordId,
              srvRecordInput(
                hostname,
                publicPort,
                srvConfiguration.service,
                srvConfiguration.protocol,
                address.type === "CNAME" ? publicHost : hostname
              ),
              assignment.instanceId
            )).id
          : (yield* createCloudflareSrvRecordEffect(
              credential.apiToken,
              credential.zoneId,
              srvRecordInput(
                hostname,
                publicPort,
                srvConfiguration.service,
                srvConfiguration.protocol,
                address.type === "CNAME" ? publicHost : hostname
              ),
              assignment.instanceId
            )).id
        : null
      if (!srvConfiguration && assignment.srvRecordId) {
        yield* deleteCloudflareRecordEffect(
          credential.apiToken,
          credential.zoneId,
          assignment.srvRecordId
        )
      }
      yield* updateInstanceDomainEndpointEffect({
        addressRecordType: address.type,
        instanceId: assignment.instanceId,
        publicHost,
        publicPort,
        relayId: assignment.relayId,
        srvProtocol: srvConfiguration?.protocol ?? null,
        srvRecordId: nextSrvRecordId,
        srvService: srvConfiguration?.service ?? null,
        supportsSrv: srvConfiguration !== null,
      })
      const updated = yield* loadInstanceDomainAssignmentEffect(
        assignment.relayId,
        assignment.instanceId
      )
      if (!updated) {
        return yield* domainFailure("The vanity address disappeared")
      }
      return updated
    })
    return yield* sync.pipe(
      Effect.tapError((error) =>
        recordInstanceDomainSyncErrorEffect(
          assignment.relayId,
          assignment.instanceId,
          error.message
        ).pipe(Effect.catch(() => Effect.void))
      )
    )
  }
)

const renameVanityRecordsEffect = Effect.fn("domains.instance.renameRecords")(
  function* (
    credential: CloudflareIntegrationCredential,
    assignment: InstanceDomainAssignment,
    vanityLabel: string
  ) {
    const addressRecordId = assignment.addressRecordId
    const addressRecordType = assignment.addressRecordType
    if (!addressRecordId || !addressRecordType) {
      return yield* domainFailure(
        "The managed address is missing its Cloudflare record"
      )
    }
    const previousHostname = `${assignment.vanityLabel}.${assignment.domain}`
    const nextHostname = `${vanityLabel}.${assignment.domain}`
    const rename = Effect.gen(function* () {
      yield* updateCloudflareAddressRecordEffect(
        credential.apiToken,
        credential.zoneId,
        addressRecordId,
        cloudflareAddressRecord(nextHostname, assignment.publicHost),
        assignment.instanceId
      )
      if (
        assignment.supportsSrv &&
        assignment.srvRecordId &&
        assignment.srvService &&
        assignment.srvProtocol
      ) {
        yield* updateCloudflareSrvRecordEffect(
          credential.apiToken,
          credential.zoneId,
          assignment.srvRecordId,
          srvRecordInput(
            nextHostname,
            assignment.publicPort,
            assignment.srvService,
            assignment.srvProtocol,
            assignment.addressRecordType === "CNAME"
              ? assignment.publicHost
              : nextHostname
          ),
          assignment.instanceId
        )
      }
      yield* updateInstanceDomainLabelEffect({
        instanceId: assignment.instanceId,
        relayId: assignment.relayId,
        vanityLabel,
      })
    })
    yield* rename.pipe(
      Effect.catch((error) =>
        rollbackVanityRenameEffect(
          credential,
          assignment,
          previousHostname
        ).pipe(Effect.andThen(Effect.fail(error)))
      )
    )
    const updated = yield* loadInstanceDomainAssignmentEffect(
      assignment.relayId,
      assignment.instanceId
    )
    if (!updated) return yield* domainFailure("The vanity address disappeared")
    return assignmentOverview(updated)
  }
)

const rollbackVanityRenameEffect = Effect.fn("domains.instance.rollbackRename")(
  function* (
    credential: CloudflareIntegrationCredential,
    assignment: InstanceDomainAssignment,
    hostname: string
  ) {
    if (assignment.addressRecordId) {
      yield* updateCloudflareAddressRecordEffect(
        credential.apiToken,
        credential.zoneId,
        assignment.addressRecordId,
        cloudflareAddressRecord(hostname, assignment.publicHost),
        assignment.instanceId
      ).pipe(Effect.catch(() => Effect.void))
    }
    if (
      assignment.srvRecordId &&
      assignment.srvService &&
      assignment.srvProtocol
    ) {
      yield* updateCloudflareSrvRecordEffect(
        credential.apiToken,
        credential.zoneId,
        assignment.srvRecordId,
        srvRecordInput(
          hostname,
          assignment.publicPort,
          assignment.srvService,
          assignment.srvProtocol,
          assignment.addressRecordType === "CNAME"
            ? assignment.publicHost
            : hostname
        ),
        assignment.instanceId
      ).pipe(Effect.catch(() => Effect.void))
    }
  }
)

const availableVanityLabelEffect = Effect.fn("domains.instance.availableLabel")(
  function* (
    credential: CloudflareIntegrationCredential,
    candidates: Array<string>,
    owner?: { instanceId: string; relayId: string }
  ) {
    const used = yield* loadUsedVanityLabelsEffect(credential.domain, owner)
    for (const candidate of candidates) {
      if (
        used.has(candidate) ||
        !vanityLabelAllowed(candidate, credential.blacklistPatterns)
      ) {
        continue
      }
      const available = yield* cloudflareHostnameAvailableEffect(
        credential.apiToken,
        credential.zoneId,
        `${candidate}.${credential.domain}`
      )
      if (available) return candidate
    }
    return yield* domainFailure(
      candidates.length === 1
        ? "That server address is already in use"
        : "Kiln could not find an available vanity address"
    )
  }
)

const assertVanityAvailableEffect = Effect.fn(
  "domains.instance.assertAvailable"
)(function* (credential: CloudflareIntegrationCredential, vanityLabel: string) {
  const used = yield* loadUsedVanityLabelsEffect(credential.domain)
  if (used.has(vanityLabel)) {
    return yield* domainFailure("That server address is already in use")
  }
  const available = yield* cloudflareHostnameAvailableEffect(
    credential.apiToken,
    credential.zoneId,
    `${vanityLabel}.${credential.domain}`
  )
  if (!available) {
    return yield* domainFailure("That server address is already in use")
  }
})

function srvRecordInput(
  hostname: string,
  port: number,
  service: string,
  protocol: "tcp" | "udp",
  target: string
) {
  return {
    name: `_${service}._${protocol}.${hostname}`,
    port,
    priority: 0,
    target,
    weight: 0,
  }
}

function domainSrvConfigurationMatches(
  assignment: InstanceDomainAssignment,
  configuration: ReturnType<typeof managedDomainSrvConfiguration>
): boolean {
  if (!configuration) {
    return !assignment.supportsSrv && assignment.srvRecordId === null
  }
  return (
    assignment.supportsSrv &&
    assignment.srvRecordId !== null &&
    assignment.srvService === configuration.service &&
    assignment.srvProtocol === configuration.protocol
  )
}

function assignmentOverview(
  assignment: InstanceDomainAssignment
): InstanceDomainOverview {
  return {
    address: managedDomainConnectAddress(assignment),
    directAddress: hostPortAddress(
      assignment.publicHost,
      assignment.publicPort
    ),
    domain: assignment.domain,
    lastError: assignment.lastError,
    srvActive: domainHasActiveSrvRecord(assignment),
    status: assignment.status,
    supportsSrv: assignment.supportsSrv,
    vanityLabel: assignment.vanityLabel,
  }
}

function assignmentKey(relayId: string, instanceId: string): string {
  return `${relayId}:${instanceId}`
}

function assignmentOwner(instance: { id: string; relayId: string }): {
  instanceId: string
  relayId: string
} {
  return {
    instanceId: instance.id,
    relayId: instance.relayId,
  }
}

export function managedAddressForInstance(
  addresses: z.infer<typeof managedDomainAddressMapSchema>,
  instance: Pick<
    FleetRelayInstance,
    "connectAddress" | "id" | "publicHost" | "publicPort" | "relayId"
  >
): string {
  const assignment = addresses[assignmentKey(instance.relayId, instance.id)]
  return assignment && managedDomainEndpointMatches(assignment, instance)
    ? assignment.address
    : instance.connectAddress
}

async function requireDomainAdministrator() {
  const user = await requireEligibleResourceUser()
  if (!isPlatformAdmin(user)) {
    throw new Error("Platform administrator access required")
  }
  return user
}

async function loadWritableInstance(relayId: string, instanceId: string) {
  const user = await requireEligibleResourceUser()
  const relay = await requiredRelay(relayId)
  await requireRelayPermission({
    instanceId,
    permission: "instance.network.write",
    relayId,
    user,
  })
  const snapshot = relaySnapshotSchema.parse(
    await runAppEffect(
      "relay.snapshot.domain",
      relayJsonEffect(relay, "/v1/snapshot", (input) => input)
    )
  )
  const instance = snapshot.instances.find((item) => item.id === instanceId)
  if (!instance) throw new Error("Instance not found")
  return { instance: relayInstanceSchema.parse(instance) }
}

async function requiredRelay(id: string): Promise<PersistedRelay> {
  const relay = (await listPersistedRelays()).find(
    (item) => item.enabled && item.id === id
  )
  if (!relay) throw new Error("Relay not found")
  return relay
}

function domainFailure(
  message: string
): Effect.Effect<never, ExternalServiceError> {
  return Effect.fail(
    ExternalServiceError.make({
      message,
      service: "Cloudflare",
    })
  )
}
