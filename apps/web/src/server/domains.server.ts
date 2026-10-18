import { randomUUID } from "node:crypto"

import type { RelayInstance } from "@workspace/contracts"
import {
  builtinTailscaleBrickId,
  relayInstanceSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect, Option, Random, Result, Semaphore } from "effect"
import { z } from "zod"

import {
  cloudflareAddressRecord,
  cloudflareHostnameAvailableEffect,
  createCloudflareAddressRecordEffect,
  createCloudflareSrvRecordEffect,
  deleteCloudflareRecordEffect,
  listCloudflareZonesEffect,
  replaceCloudflareAddressRecordEffect,
  updateCloudflareAddressRecordEffect,
  updateCloudflareSrvRecordEffect,
} from "@/effect/cloudflare-api"
import { ensuringPromise, recoverPromise } from "@/effect/promise"
import {
  activateInstanceDomainAssignmentEffect,
  clearInstanceDomainRecordsEffect,
  countInstanceDomainsByDomainEffect,
  deleteInstanceDomainAssignmentEffect,
  deleteRelayInstanceDomainAssignmentsEffect,
  insertInstanceDomainAssignmentEffect,
  loadActiveInstanceDomainAssignmentsEffect,
  loadCloudflareIntegrationCredentialEffect,
  loadDomainIntegrationEffect,
  loadInstanceDomainAssignmentEffect,
  loadInstanceDomainAssignmentsEffect,
  loadInstanceDomainAssignmentsForInstanceEffect,
  loadInstanceDomainOptOutEffect,
  loadRelayInstanceDomainAssignmentsEffect,
  loadUsedVanityLabelsEffect,
  markInstanceDomainRemovingEffect,
  recordInstanceDomainErrorEffect,
  recordInstanceDomainSyncErrorEffect,
  reserveInstanceDomainAssignmentEffect,
  saveCloudflareIntegrationEffect,
  setInstanceDomainOptOutEffect,
  setInstanceDomainPrimaryEffect,
  updateInstanceDomainAddressRecordEffect,
  updateInstanceDomainEndpointEffect,
  updateInstanceDomainLabelEffect,
  type CloudflareIntegrationCredential,
  type InstanceDomainAssignment,
  type ManagedDomain,
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
  domainInZone,
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
  CreateInstanceDomainInput,
  DiscoverDomainsInput,
  InstanceDomainInput,
  InstanceDomainOverview,
  ManagedDomainOverview,
  RemoveInstanceDomainInput,
  UpdateInstanceDomainInput,
} from "@/server/domains"

type DomainInstance = RelayInstance & { relayId: string }

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

// Provisioning, renaming, and removing a game server's domains each read its
// assignments and then change Cloudflare records. One permit per game server
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
  const zoneNames = new Map(
    integration?.domains.map((domain) => [domain.domain, domain.zoneName])
  )
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
  const domainCounts = new Map<string, number>()
  for (const assignment of assignments) {
    const key = assignmentKey(assignment.relayId, assignment.instanceId)
    domainCounts.set(key, (domainCounts.get(key) ?? 0) + 1)
  }
  const managedDomains = assignments.map(
    (assignment): ManagedDomainOverview => {
      const key = assignmentKey(assignment.relayId, assignment.instanceId)
      const server = servers.get(key)
      const shortId = assignment.instanceId.slice(0, 8)
      return {
        address: managedDomainConnectAddress(assignment),
        domain: assignment.domain,
        domainCount: domainCounts.get(key) ?? 1,
        id: assignment.id,
        instanceId: assignment.instanceId,
        lastError: assignment.lastError,
        port: assignment.publicPort,
        primary: assignment.primary,
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
        zoneName: zoneNames.get(assignment.domain) ?? null,
      }
    }
  )
  return {
    hearthDomain: kilnRootDomain(),
    integration,
    managedDomains,
  }
}

/** The zones a pasted token, or the saved one, can manage. */
export async function discoverCloudflareDomainsHandler(
  data: DiscoverDomainsInput
) {
  await requireDomainAdministrator()
  const apiToken = data.apiToken ?? (await savedApiToken())
  if (!apiToken) throw new Error("Enter a Cloudflare API token")
  const zones = await runAppEffect(
    "cloudflare.zones.list",
    listCloudflareZonesEffect(apiToken)
  )
  if (zones.length === 0) {
    throw new Error(
      "This token can't read any active zones. Give it Zone Read and DNS Edit on the domains Kiln should use."
    )
  }
  return { zones }
}

export async function configureDomainIntegrationHandler(
  data: ConfigureDomainInput
) {
  await requireDomainAdministrator()
  const blacklistPatterns = validateBlacklistPatterns(data.blacklistPatterns)
  const requested = [
    ...new Map(data.domains.map((item) => [item.domain, item])).values(),
  ]
  if (!requested.some((item) => item.domain === data.defaultDomain)) {
    throw new Error("Choose a default domain from the list")
  }
  // The dialog lists one domain per zone, so its choices can't collapse.
  const zoneIds = new Set(requested.map((item) => item.zoneId))
  if (zoneIds.size !== requested.length) {
    throw new Error("Choose one domain per Cloudflare zone")
  }
  const apiToken = data.apiToken ?? (await savedApiToken())
  if (!apiToken) throw new Error("Enter a Cloudflare API token")
  const zones = await runAppEffect(
    "cloudflare.zones.list",
    listCloudflareZonesEffect(apiToken)
  )
  const zonesById = new Map(zones.map((zone) => [zone.id, zone]))
  const domains = requested.map((item): ManagedDomain => {
    const zone = zonesById.get(item.zoneId)
    if (!zone) {
      throw new Error(`This token can't manage the zone for ${item.domain}`)
    }
    if (!domainInZone(item.domain, zone.name)) {
      throw new Error(`${item.domain} is not in the ${zone.name} zone`)
    }
    return {
      domain: item.domain,
      enabled: true,
      isDefault: item.domain === data.defaultDomain,
      zoneId: zone.id,
      zoneName: zone.name,
    }
  })
  // Domains left out that still have game server domains stay, disabled;
  // the save decides which under its locks.
  await runAppEffect(
    "domains.integration.save",
    saveCloudflareIntegrationEffect({
      apiToken,
      blacklistPatterns,
      domains,
      enabled: data.enabled,
      reachableZoneIds: new Set(zonesById.keys()),
      strategy: data.strategy,
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
  if (!integration) {
    throw new Error("Configure vanity domains before syncing")
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
  const [assignments, integration] = await Promise.all([
    runAppEffect(
      "domains.assignments.instance",
      loadInstanceDomainAssignmentsForInstanceEffect(
        data.relayId,
        data.instanceId
      )
    ),
    runAppEffect("domains.integration.load", loadDomainIntegrationEffect()),
  ])
  const primary = assignments[0]
  return {
    assignment: primary ? assignmentOverview(primary) : null,
    managedDomain:
      integration?.enabled === true
        ? (integration.domains[0]?.domain ?? null)
        : null,
  }
}

/**
 * Points a new domain at a game server. Its first domain becomes its connect
 * address; later ones do when `primary` is set. Administrators only: each
 * domain is a record under the platform's zones.
 */
export async function createInstanceDomainHandler(
  data: CreateInstanceDomainInput
) {
  await requireDomainAdministrator()
  const { instance } = await loadWritableInstance(data.relayId, data.instanceId)
  // A failed create still leaves a failed row behind, so publish either way.
  return ensuringPromise(
    () =>
      runAppEffect(
        "domains.instance.create",
        withInstanceDomainLock(
          data.relayId,
          data.instanceId,
          createInstanceDomainEffect(
            { ...instance, relayId: data.relayId },
            data
          ).pipe(
            // Adding a domain undoes a removal.
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
    () =>
      publishDomainChange({
        instanceId: data.instanceId,
        relayId: data.relayId,
      })
  )
}

export async function updateInstanceDomainHandler(
  data: UpdateInstanceDomainInput
) {
  // Signed in before the lookup, so an ID's existence isn't revealed.
  await requireEligibleResourceUser()
  const assignment = await runAppEffect(
    "domains.assignment.load",
    loadInstanceDomainAssignmentEffect(data.id)
  )
  if (!assignment) throw new Error("Domain not found")
  const scope = {
    instanceId: assignment.instanceId,
    relayId: assignment.relayId,
  }
  const { instance } = await loadWritableInstance(
    scope.relayId,
    scope.instanceId
  )
  // A failed rename can still clear leftover records, so publish either way.
  return ensuringPromise(
    () =>
      runAppEffect(
        "domains.instance.update",
        withInstanceDomainLock(
          scope.relayId,
          scope.instanceId,
          updateInstanceDomainEffect(
            { ...instance, relayId: scope.relayId },
            data
          )
        )
      ),
    () => publishDomainChange(scope)
  )
}

/**
 * Removes one domain. Removing a game server's last domain keeps it removed:
 * starts, port changes, and Sync skip the server until a domain is added again.
 */
export async function removeInstanceDomainHandler(
  data: RemoveInstanceDomainInput
) {
  await requireDomainAdministrator()
  const assignment = await runAppEffect(
    "domains.assignment.load",
    loadInstanceDomainAssignmentEffect(data.id)
  )
  if (!assignment) return
  const scope = {
    instanceId: assignment.instanceId,
    relayId: assignment.relayId,
  }
  // A failed removal still changes the row, so publish either way.
  await ensuringPromise(
    () =>
      runAppEffect(
        "domains.instance.remove",
        removeInstanceDomainEffect(scope.relayId, scope.instanceId, data.id)
      ),
    () => publishDomainChange(scope)
  )
}

export async function provisionInstanceDomainBestEffort(
  instance: RelayInstance,
  relayId: string
): Promise<void> {
  const changed = await runAppEffect(
    "domains.instance.provision",
    provisionInstanceDomainEffect({ ...instance, relayId }).pipe(
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
  if (changed) publishDomainChange({ instanceId: instance.id, relayId })
}

export async function provisionInstanceDomain(
  instance: RelayInstance,
  relayId: string
): Promise<void> {
  const changed = await runAppEffect(
    "domains.instance.provision",
    provisionInstanceDomainEffect({ ...instance, relayId })
  )
  if (changed) publishDomainChange({ instanceId: instance.id, relayId })
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
      Effect.map((assignments) => {
        const addresses: z.infer<typeof managedDomainAddressMapSchema> = {}
        // Primaries come first, so a game server advertises its primary,
        // or another active domain while the primary is failing.
        for (const assignment of assignments) {
          const key = assignmentKey(assignment.relayId, assignment.instanceId)
          addresses[key] ??= {
            address: managedDomainConnectAddress(assignment),
            publicHost: assignment.publicHost,
            publicPort: assignment.publicPort,
          }
        }
        return addresses
      })
    ),
    policy: managedDomainAddressCachePolicy,
  })
})

// A removal stays recorded here: the game server may survive a failed
// deletion. Post-delete cleanup clears it once the Relay has removed it.
export const deleteInstanceDomainEffect = Effect.fn("domains.instance.delete")(
  function* (relayId: string, instanceId: string) {
    const assignments = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      relayId,
      instanceId
    )
    for (const assignment of assignments) {
      yield* deleteAssignmentRecordsEffect(assignment)
    }
  },
  (effect, relayId, instanceId) =>
    withInstanceDomainLock(relayId, instanceId, effect)
)

export const removeInstanceDomainEffect = Effect.fn("domains.instance.remove")(
  function* (relayId: string, instanceId: string, id: string) {
    const assignments = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      relayId,
      instanceId
    )
    const assignment = assignments.find((item) => item.id === id)
    if (!assignment) return
    const remaining = assignments.filter(
      (item) => item.id !== id && item.status !== "removing"
    )
    if (remaining.length === 0) {
      yield* setInstanceDomainOptOutEffect(relayId, instanceId, true)
    }
    // Another domain takes over as the connect address before Cloudflare is
    // touched, so it moves even if the delete fails.
    const successor =
      remaining.find((item) => item.status === "active") ?? remaining[0]
    if (assignment.primary && successor) {
      yield* setInstanceDomainPrimaryEffect({
        id: successor.id,
        instanceId,
        relayId,
      })
    }
    // Keep the removal. Cloudflare deletes are idempotent, so deleting again
    // finishes it; until then the domain shows as failing to delete, Hearth
    // stops advertising it, and nothing re-creates it.
    yield* markInstanceDomainRemovingEffect(id)
    yield* invalidateManagedDomainAddressesEffect
    yield* deleteAssignmentRecordsEffect(assignment).pipe(
      Effect.tapError((error) =>
        recordInstanceDomainSyncErrorEffect(
          id,
          `Delete failed: ${error.message}`
        ).pipe(Effect.ignore)
      )
    )
  },
  (effect, relayId, instanceId) =>
    withInstanceDomainLock(relayId, instanceId, effect)
)

// A failed provision or removal can leave records behind an assignment that
// isn't active. Delete them before choosing a name again, so the new records
// don't orphan them and they don't make the domain's own name look taken.
const releaseRecordsEffect = Effect.fn("domains.instance.releaseRecords")(
  function* (
    assignment: InstanceDomainAssignment,
    credential: CloudflareIntegrationCredential
  ) {
    const recordIds = assignmentRecordIds(assignment)
    if (recordIds.length === 0) return
    const zoneId = yield* assignmentZoneIdEffect(assignment)
    yield* Effect.all(
      recordIds.map((recordId) =>
        deleteCloudflareRecordEffect(credential.apiToken, zoneId, recordId)
      ),
      { concurrency: "unbounded" }
    )
    yield* clearInstanceDomainRecordsEffect(assignment.id)
  }
)

const deleteAssignmentRecordsEffect = Effect.fn(
  "domains.instance.deleteRecords"
)(function* (assignment: InstanceDomainAssignment) {
  const credential =
    assignmentRecordIds(assignment).length > 0
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
  const recordIds = assignmentRecordIds(assignment)
  if (recordIds.length > 0) {
    if (!credential) {
      return yield* domainFailure(
        "Cloudflare credentials are required to remove this managed address"
      )
    }
    const zoneId = yield* assignmentZoneIdEffect(assignment)
    yield* Effect.all(
      recordIds.map((recordId) =>
        deleteCloudflareRecordEffect(credential.apiToken, zoneId, recordId)
      ),
      { concurrency: "unbounded" }
    )
  }
  yield* deleteInstanceDomainAssignmentEffect(assignment.id)
  yield* invalidateManagedDomainAddressesEffect
})

export const removeRelayManagedDomainsEffect = Effect.fn(
  "domains.relay.removeAssignments"
)(function* (relayId: string, removeCloudflareRecords: boolean) {
  const assignments = yield* loadRelayInstanceDomainAssignmentsEffect(relayId)
  const withRecords = assignments.filter(
    (assignment) => assignmentRecordIds(assignment).length > 0
  )
  if (removeCloudflareRecords && withRecords.length > 0) {
    const credential = yield* loadCloudflareIntegrationCredentialEffect()
    yield* Effect.all(
      withRecords.map((assignment) =>
        assignmentZoneIdEffect(assignment).pipe(
          Effect.flatMap((zoneId) =>
            Effect.all(
              assignmentRecordIds(assignment).map((recordId) =>
                deleteCloudflareRecordEffect(
                  credential.apiToken,
                  zoneId,
                  recordId
                )
              ),
              { concurrency: "unbounded" }
            )
          )
        )
      ),
      { concurrency: "unbounded" }
    )
  }
  yield* deleteRelayInstanceDomainAssignmentsEffect(relayId)
  yield* invalidateManagedDomainAddressesEffect
  return assignments.length
})

/**
 * Brings a game server's domains in line with its endpoint, retries failed
 * ones, and gives a server without any its first domain. Reports whether
 * anything changed.
 */
const provisionInstanceDomainEffect = Effect.fn("domains.instance.provision")(
  function* (instance: DomainInstance) {
    if (!instance.publicHost || !instance.publicPort) return false
    const integration = yield* loadDomainIntegrationEffect()
    if (!integration) return false
    const assignments = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      instance.relayId,
      instance.id
    )
    if (assignments.length === 0) {
      if (!integration.enabled) return false
      // A game server whose last domain was removed doesn't get a new one.
      // Its other domains still follow it below, since someone kept or added
      // them, and ones being deleted are left to their delete.
      if (yield* loadInstanceDomainOptOutEffect(instance.relayId, instance.id)) {
        return false
      }
      const credential = yield* loadCloudflareIntegrationCredentialEffect()
      const domain = yield* chooseDomainEffect(credential)
      const vanityLabel = yield* availableVanityLabelEffect(
        credential,
        domain,
        generateVanityCandidates(credential.blacklistPatterns)
      )
      yield* provisionVanityRecordsEffect(credential, instance, domain, {
        id: randomUUID(),
        insert: true,
        primary: true,
        vanityLabel,
      }).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
      return true
    }

    const credential = yield* loadCloudflareIntegrationCredentialEffect()
    const srvConfiguration = managedDomainSrvConfiguration(instance)
    let changed = false
    // Brings one domain in line with the endpoint. Reports whether it changed.
    const reconcileOne = Effect.fnUntraced(function* (
      assignment: InstanceDomainAssignment
    ) {
      // Left to its delete, which a retry finishes.
      if (assignment.status === "removing") return false
      if (assignment.status === "active") {
        if (
          managedDomainEndpointMatches(assignment, instance) &&
          domainSrvConfigurationMatches(assignment, srvConfiguration)
        ) {
          return false
        }
        yield* syncVanityEndpointEffect(credential, assignment, instance)
        return true
      }
      yield* releaseRecordsEffect(assignment, credential)
      const domain = yield* configuredDomainEffect(
        credential,
        assignment.domain,
        true
      )
      // The primary was likely named by Kiln, so it may take a new name;
      // other domains were named by hand and keep theirs.
      const candidates = assignment.primary
        ? [
            ...new Set([
              assignment.vanityLabel,
              ...generateVanityCandidates(credential.blacklistPatterns),
            ]),
          ]
        : [assignment.vanityLabel]
      const vanityLabel = yield* availableVanityLabelEffect(
        credential,
        domain,
        candidates,
        assignment.id
      ).pipe(
        Effect.tapError((error) =>
          recordInstanceDomainErrorEffect(assignment.id, error.message)
        )
      )
      yield* provisionVanityRecordsEffect(credential, instance, domain, {
        id: assignment.id,
        insert: false,
        primary: assignment.primary,
        vanityLabel,
      })
      return true
    })
    const reconcile = Effect.gen(function* () {
      if (!assignments.some((assignment) => assignment.primary)) {
        const first = assignments.find(
          (assignment) => assignment.status !== "removing"
        )
        if (first) {
          yield* setInstanceDomainPrimaryEffect({
            id: first.id,
            instanceId: instance.id,
            relayId: instance.relayId,
          })
          changed = true
        }
      }
      // Each domain on its own, so one failing doesn't hold back the rest;
      // the first failure is reported once they've all had a turn.
      let failure: Option.Option<
        Effect.Error<ReturnType<typeof reconcileOne>>
      > = Option.none()
      for (const assignment of assignments) {
        const outcome = yield* Effect.result(reconcileOne(assignment))
        if (Result.isSuccess(outcome)) {
          if (outcome.success) changed = true
        } else if (Option.isNone(failure)) {
          failure = Option.some(outcome.failure)
        }
      }
      if (Option.isSome(failure)) return yield* Effect.fail(failure.value)
    })
    yield* reconcile.pipe(
      Effect.ensuring(
        Effect.suspend(() =>
          changed ? invalidateManagedDomainAddressesEffect : Effect.void
        )
      )
    )
    return changed
  },
  (effect, instance) =>
    withInstanceDomainLock(instance.relayId, instance.id, effect)
)

const createInstanceDomainEffect = Effect.fn("domains.instance.create")(
  function* (
    instance: DomainInstance,
    input: Pick<CreateInstanceDomainInput, "domain" | "primary" | "vanityLabel">
  ) {
    if (!instance.publicHost || !instance.publicPort) {
      return yield* domainFailure(
        "Update this Relay before assigning a vanity address"
      )
    }
    const credential = yield* loadCloudflareIntegrationCredentialEffect()
    const domain = yield* configuredDomainEffect(credential, input.domain)
    if (
      input.vanityLabel !== undefined &&
      !vanityLabelAllowed(input.vanityLabel, credential.blacklistPatterns)
    ) {
      return yield* domainFailure(
        "That server address is reserved by the platform administrator"
      )
    }
    const existing = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      instance.relayId,
      instance.id
    )
    const vanityLabel = yield* availableVanityLabelEffect(
      credential,
      domain,
      input.vanityLabel === undefined
        ? generateVanityCandidates(credential.blacklistPatterns)
        : [input.vanityLabel]
    )
    const id = randomUUID()
    // Promoted only once its records exist, so a failed create leaves the
    // current connect address alone.
    const overview = yield* provisionVanityRecordsEffect(
      credential,
      instance,
      domain,
      { id, insert: true, primary: existing.length === 0, vanityLabel }
    ).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
    if (input.primary && existing.length > 0) {
      yield* setInstanceDomainPrimaryEffect({
        id,
        instanceId: instance.id,
        relayId: instance.relayId,
      }).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
    }
    return overview
  }
)

const updateInstanceDomainEffect = Effect.fn("domains.instance.update")(
  function* (
    instance: DomainInstance,
    input: Pick<
      UpdateInstanceDomainInput,
      "domain" | "id" | "primary" | "vanityLabel"
    >
  ) {
    if (!instance.publicHost || !instance.publicPort) {
      return yield* domainFailure(
        "Update this Relay before assigning a vanity address"
      )
    }
    const assignment = yield* loadInstanceDomainAssignmentEffect(input.id)
    if (
      !assignment ||
      assignment.relayId !== instance.relayId ||
      assignment.instanceId !== instance.id
    ) {
      return yield* domainFailure("Domain not found")
    }
    if (assignment.status === "removing") {
      return yield* domainFailure(
        "Finish deleting this domain before editing it"
      )
    }
    const credential = yield* loadCloudflareIntegrationCredentialEffect()
    // Renaming within a disabled domain is fine; moving onto one isn't.
    const domain = yield* configuredDomainEffect(
      credential,
      input.domain,
      input.domain === assignment.domain
    )
    if (!vanityLabelAllowed(input.vanityLabel, credential.blacklistPatterns)) {
      return yield* domainFailure(
        "That server address is reserved by the platform administrator"
      )
    }
    const update = Effect.gen(function* () {
      const renamed =
        assignment.domain !== domain.domain ||
        assignment.vanityLabel !== input.vanityLabel
      if (assignment.status !== "active") {
        yield* releaseRecordsEffect(assignment, credential)
        yield* availableVanityLabelEffect(
          credential,
          domain,
          [input.vanityLabel],
          assignment.id
        )
        return yield* provisionVanityRecordsEffect(
          credential,
          instance,
          domain,
          {
            id: assignment.id,
            insert: false,
            primary: assignment.primary,
            vanityLabel: input.vanityLabel,
          }
        )
      }
      const current = managedDomainEndpointMatches(assignment, instance)
        ? assignment
        : yield* syncVanityEndpointEffect(credential, assignment, instance)
      if (!renamed) return assignmentOverview(current)
      yield* availableVanityLabelEffect(
        credential,
        domain,
        [input.vanityLabel],
        assignment.id
      )
      if (current.zoneId === domain.zoneId) {
        return yield* renameVanityRecordsEffect(
          credential,
          current,
          domain.domain,
          input.vanityLabel
        )
      }
      // Records can't move between zones: replace them in the new one.
      yield* releaseRecordsEffect(current, credential)
      return yield* provisionVanityRecordsEffect(credential, instance, domain, {
        id: assignment.id,
        insert: false,
        primary: assignment.primary,
        vanityLabel: input.vanityLabel,
      })
    })
    const overview = yield* update.pipe(
      Effect.ensuring(invalidateManagedDomainAddressesEffect)
    )
    if (input.primary && !assignment.primary) {
      yield* setInstanceDomainPrimaryEffect({
        id: assignment.id,
        instanceId: instance.id,
        relayId: instance.relayId,
      }).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
    }
    return overview
  }
)

/** Picks the domain a new game server's first domain goes under. */
const chooseDomainEffect = Effect.fn("domains.instance.chooseDomain")(
  function* (credential: CloudflareIntegrationCredential) {
    // Loaded default first, so it wins ties.
    const domains = credential.domains.filter((domain) => domain.enabled)
    const [fallback] = domains
    if (!fallback) {
      return yield* domainFailure(
        "Enable a domain in the vanity configuration first"
      )
    }
    if (credential.strategy === "random") {
      const index = yield* Random.nextIntBetween(0, domains.length, {
        halfOpen: true,
      })
      return domains[index] ?? fallback
    }
    if (credential.strategy === "balanced") {
      const usage = yield* countInstanceDomainsByDomainEffect()
      return domains.reduce((least, domain) =>
        (usage.get(domain.domain) ?? 0) < (usage.get(least.domain) ?? 0)
          ? domain
          : least
      )
    }
    return fallback
  }
)

const provisionVanityRecordsEffect = Effect.fn(
  "domains.instance.createRecords"
)(function* (
  credential: CloudflareIntegrationCredential,
  instance: DomainInstance,
  domain: ManagedDomain,
  target: {
    id: string
    /** A new row, or a row whose records were released. */
    insert: boolean
    primary: boolean
    vanityLabel: string
  }
) {
  const publicHost = instance.publicHost
  const publicPort = instance.publicPort
  if (!publicHost || !publicPort) {
    return yield* domainFailure("The Relay did not report a public endpoint")
  }
  const { id, vanityLabel } = target
  const srvConfiguration = managedDomainSrvConfiguration(instance)
  const supportsSrv = srvConfiguration !== null
  const srvProtocol = srvConfiguration?.protocol ?? null
  const srvService = srvConfiguration?.service ?? null
  const reservation = {
    domain: domain.domain,
    id,
    zoneId: domain.zoneId,
    publicHost,
    publicPort,
    srvProtocol,
    srvService,
    supportsSrv,
    vanityLabel,
  }
  yield* target.insert
    ? insertInstanceDomainAssignmentEffect({
        ...reservation,
        instanceId: instance.id,
        primary: target.primary,
        relayId: instance.relayId,
      })
    : reserveInstanceDomainAssignmentEffect(reservation)
  const hostname = `${vanityLabel}.${domain.domain}`
  const address = cloudflareAddressRecord(hostname, publicHost)
  const addressRecord = yield* createCloudflareAddressRecordEffect(
    credential.apiToken,
    domain.zoneId,
    address,
    instance.id
  ).pipe(
    Effect.tapError((error) =>
      recordInstanceDomainErrorEffect(id, error.message)
    )
  )
  const srvRecord =
    supportsSrv && srvProtocol && srvService
      ? yield* createCloudflareSrvRecordEffect(
          credential.apiToken,
          domain.zoneId,
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
              domain.zoneId,
              addressRecord.id
            ).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(recordInstanceDomainErrorEffect(id, error.message)),
              Effect.andThen(Effect.fail(error))
            )
          )
        )
      : null
  yield* activateInstanceDomainAssignmentEffect({
    addressRecordId: addressRecord.id,
    addressRecordType: address.type,
    id,
    srvRecordId: srvRecord?.id ?? null,
  }).pipe(
    Effect.catch((error) =>
      Effect.all([
        deleteCloudflareRecordEffect(
          credential.apiToken,
          domain.zoneId,
          addressRecord.id
        ).pipe(Effect.catch(() => Effect.void)),
        srvRecord
          ? deleteCloudflareRecordEffect(
              credential.apiToken,
              domain.zoneId,
              srvRecord.id
            ).pipe(Effect.catch(() => Effect.void))
          : Effect.void,
      ]).pipe(
        Effect.andThen(recordInstanceDomainErrorEffect(id, error.message)),
        Effect.andThen(Effect.fail(error))
      )
    )
  )
  const assignment = yield* loadInstanceDomainAssignmentEffect(id)
  if (!assignment) {
    return yield* domainFailure("The vanity address could not be saved")
  }
  return assignmentOverview(assignment)
})

const syncVanityEndpointEffect = Effect.fn("domains.instance.syncEndpoint")(
  function* (
    credential: CloudflareIntegrationCredential,
    assignment: InstanceDomainAssignment,
    instance: DomainInstance
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
      const zoneId = yield* assignmentZoneIdEffect(assignment)
      if (assignment.addressRecordType === address.type) {
        yield* updateCloudflareAddressRecordEffect(
          credential.apiToken,
          zoneId,
          addressRecordId,
          address,
          assignment.instanceId
        )
      } else {
        const replacement = yield* replaceCloudflareAddressRecordEffect(
          credential.apiToken,
          zoneId,
          addressRecordId,
          address,
          assignment.instanceId
        )
        yield* updateInstanceDomainAddressRecordEffect({
          addressRecordId: replacement.id,
          addressRecordType: address.type,
          id: assignment.id,
        })
      }
      const srvTarget = address.type === "CNAME" ? publicHost : hostname
      const nextSrvRecordId = srvConfiguration
        ? assignment.srvRecordId
          ? (yield* updateCloudflareSrvRecordEffect(
              credential.apiToken,
              zoneId,
              assignment.srvRecordId,
              srvRecordInput(
                hostname,
                publicPort,
                srvConfiguration.service,
                srvConfiguration.protocol,
                srvTarget
              ),
              assignment.instanceId
            )).id
          : (yield* createCloudflareSrvRecordEffect(
              credential.apiToken,
              zoneId,
              srvRecordInput(
                hostname,
                publicPort,
                srvConfiguration.service,
                srvConfiguration.protocol,
                srvTarget
              ),
              assignment.instanceId
            )).id
        : null
      if (!srvConfiguration && assignment.srvRecordId) {
        yield* deleteCloudflareRecordEffect(
          credential.apiToken,
          zoneId,
          assignment.srvRecordId
        )
      }
      yield* updateInstanceDomainEndpointEffect({
        addressRecordType: address.type,
        id: assignment.id,
        publicHost,
        publicPort,
        srvProtocol: srvConfiguration?.protocol ?? null,
        srvRecordId: nextSrvRecordId,
        srvService: srvConfiguration?.service ?? null,
        supportsSrv: srvConfiguration !== null,
      })
      const updated = yield* loadInstanceDomainAssignmentEffect(assignment.id)
      if (!updated) {
        return yield* domainFailure("The vanity address disappeared")
      }
      return updated
    })
    return yield* sync.pipe(
      Effect.tapError((error) =>
        recordInstanceDomainSyncErrorEffect(assignment.id, error.message).pipe(
          Effect.catch(() => Effect.void)
        )
      )
    )
  }
)

/** Renames a domain's records within their zone. */
const renameVanityRecordsEffect = Effect.fn("domains.instance.renameRecords")(
  function* (
    credential: CloudflareIntegrationCredential,
    assignment: InstanceDomainAssignment,
    domain: string,
    vanityLabel: string
  ) {
    const addressRecordId = assignment.addressRecordId
    const addressRecordType = assignment.addressRecordType
    if (!addressRecordId || !addressRecordType) {
      return yield* domainFailure(
        "The managed address is missing its Cloudflare record"
      )
    }
    const zoneId = yield* assignmentZoneIdEffect(assignment)
    const previousHostname = `${assignment.vanityLabel}.${assignment.domain}`
    const nextHostname = `${vanityLabel}.${domain}`
    const rename = Effect.gen(function* () {
      yield* updateCloudflareAddressRecordEffect(
        credential.apiToken,
        zoneId,
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
          zoneId,
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
        domain,
        id: assignment.id,
        vanityLabel,
      })
    })
    yield* rename.pipe(
      Effect.catch((error) =>
        rollbackVanityRenameEffect(
          credential,
          zoneId,
          assignment,
          previousHostname
        ).pipe(Effect.andThen(Effect.fail(error)))
      )
    )
    const updated = yield* loadInstanceDomainAssignmentEffect(assignment.id)
    if (!updated) return yield* domainFailure("The vanity address disappeared")
    return assignmentOverview(updated)
  }
)

const rollbackVanityRenameEffect = Effect.fn("domains.instance.rollbackRename")(
  function* (
    credential: CloudflareIntegrationCredential,
    zoneId: string,
    assignment: InstanceDomainAssignment,
    hostname: string
  ) {
    if (assignment.addressRecordId) {
      yield* updateCloudflareAddressRecordEffect(
        credential.apiToken,
        zoneId,
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
        zoneId,
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

/**
 * The first candidate no other domain holds and Cloudflare has no record for.
 * `excludeId` is the domain being renamed, whose own name isn't taken.
 */
const availableVanityLabelEffect = Effect.fn("domains.instance.availableLabel")(
  function* (
    credential: CloudflareIntegrationCredential,
    domain: ManagedDomain,
    candidates: Array<string>,
    excludeId?: string
  ) {
    const used = yield* loadUsedVanityLabelsEffect(domain.domain, excludeId)
    for (const candidate of candidates) {
      if (
        used.has(candidate) ||
        !vanityLabelAllowed(candidate, credential.blacklistPatterns)
      ) {
        continue
      }
      const available = yield* cloudflareHostnameAvailableEffect(
        credential.apiToken,
        domain.zoneId,
        `${candidate}.${domain.domain}`
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

/**
 * A configured domain. Only enabled ones take new game server domains;
 * `existing` also accepts a disabled one a game server domain is already on.
 */
function configuredDomainEffect(
  credential: CloudflareIntegrationCredential,
  name: string,
  existing = false
): Effect.Effect<ManagedDomain, ExternalServiceError> {
  const domain = credential.domains.find((item) => item.domain === name)
  if (!domain) {
    return domainFailure(`${name} is not a configured vanity domain`)
  }
  return domain.enabled || existing
    ? Effect.succeed(domain)
    : domainFailure(`${name} isn't taking new game server domains`)
}

function assignmentZoneIdEffect(
  assignment: InstanceDomainAssignment
): Effect.Effect<string, ExternalServiceError> {
  return assignment.zoneId
    ? Effect.succeed(assignment.zoneId)
    : domainFailure(
        `${assignment.domain} is no longer a configured vanity domain`
      )
}

function assignmentRecordIds(
  assignment: InstanceDomainAssignment
): Array<string> {
  return [assignment.addressRecordId, assignment.srvRecordId].filter(
    (recordId): recordId is string => recordId !== null
  )
}

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

async function savedApiToken(): Promise<string | undefined> {
  const credential = await recoverPromise(
    () =>
      runAppEffect(
        "domains.integration.credential",
        loadCloudflareIntegrationCredentialEffect()
      ),
    () => null
  )
  return credential?.apiToken
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
