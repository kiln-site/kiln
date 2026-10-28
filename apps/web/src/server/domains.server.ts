import { randomUUID } from "node:crypto"

import type { RelayInstance } from "@workspace/contracts"
import { relayInstanceSchema, relaySnapshotSchema } from "@workspace/contracts"
import { Effect, Option, Result } from "effect"
import { z } from "zod"

import {
  cloudflareAddressRecord,
  cloudflareHostnameAvailableEffect,
  createCloudflareAddressRecordEffect,
  createCloudflareSrvRecordEffect,
  deleteCloudflareRecordEffect,
  listCloudflareRecordsEffect,
  replaceCloudflareAddressRecordEffect,
  updateCloudflareAddressRecordEffect,
  updateCloudflareSrvRecordEffect,
} from "@/effect/cloudflare-api"
import { ensuringPromise } from "@/effect/promise"
import {
  activateInstanceDomainAssignmentEffect,
  anyDomainConnectionEffect,
  assignmentHostnames,
  beginInstanceDomainRenameEffect,
  clearInstanceDomainErrorEffect,
  clearInstanceDomainRecordsEffect,
  deferInstanceDomainsEffect,
  finishInstanceDomainRenameEffect,
  listDueInstanceDomainsEffect,
  deleteInstanceDomainAssignmentEffect,
  deleteRelayInstanceDomainAssignmentsEffect,
  insertInstanceDomainAssignmentEffect,
  loadActiveInstanceDomainAssignmentsEffect,
  loadDomainConnectionCredentialEffect,
  loadInstanceDomainAssignmentEffect,
  loadInstanceDomainAssignmentsForInstanceEffect,
  loadInstanceDomainOptOutEffect,
  loadManagedDomainEffect,
  listUsableVanityDomainsEffect,
  loadRelayInstanceDomainAssignmentsEffect,
  markInstanceDomainRemovingEffect,
  markRelayInstanceDomainsRemovingEffect,
  reassignInstanceDomainsEffect,
  recordInstanceDomainErrorEffect,
  recordInstanceDomainSyncErrorEffect,
  reserveInstanceDomainAssignmentEffect,
  setInstanceDomainOptOutEffect,
  setInstanceDomainPrimaryEffect,
  updateInstanceDomainAddressRecordEffect,
  updateInstanceDomainEndpointEffect,
  type InstanceDomainAssignment,
  type ManagedDomain,
} from "@/effect/domains"
import { Database } from "@/effect/database"
import {
  DomainConfigurationError,
  ExternalServiceError,
  HostnameInUseError,
} from "@/effect/errors"
import { loadClaimedLabelsEffect } from "@/effect/hostname-claims"
import { runAppEffect } from "@/effect/runtime"
import { requireRelayPermission } from "@/lib/access-control"
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
import { vanityLabelAllowed } from "@/server/reserved-names"
import { publishDomainChange } from "@/lib/domain-realtime.server"
import type { FleetRelayInstance } from "@/lib/relay-fleet"
import { relayConnectionSnapshot } from "@/lib/relay-connection"
import { withDnsChange } from "@/lib/dns-operations"
import type { PersistedRelay } from "@/lib/relay-registry"
import { activeRelay } from "@/lib/relay-registry"
import { relayJsonEffect } from "@/lib/relay-client"
import { requireEligibleResourceUser } from "@/server/auth"
import { explainHostnameInUseEffect } from "@/server/domain-resource-access.server"
import {
  chooseVanityDomainEffect,
  domainActor,
  loadResourceOwnerIdEffect,
  ownsVanityDomain,
  vanityDomainUsable,
  type DomainActor,
} from "@/server/domain-access.server"
import {
  generateVanityCandidates,
  managedDomainSrvConfiguration,
} from "@/server/vanity-names"
import type {
  CreateInstanceDomainInput,
  InstanceDomainInput,
  InstanceDomainOverview,
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
export const invalidateManagedDomainAddressesEffect = invalidateCached(
  managedDomainAddressCachePolicy
)

// Provisioning, renaming, and removing a game server's domains each read its
// assignments and then change Cloudflare records, under the lock its web
// routes' DNS changes take too.
function withInstanceDomainLock<A, E, R>(
  kind: string,
  servers: ReadonlyArray<{
    readonly instanceId: string
    readonly relayId: string
  }>,
  effect: Effect.Effect<A, E, R>
) {
  return withDnsChange(
    kind,
    servers.map(({ instanceId, relayId }) => ({
      relayId,
      resourceId: instanceId,
      resourceType: "instance" as const,
    })),
    effect
  )
}

export async function getInstanceDomainHandler(data: InstanceDomainInput) {
  const user = await requireEligibleResourceUser()
  await requireRelayPermission({
    instanceId: data.instanceId,
    permission: "instance.network.read",
    relayId: data.relayId,
    user,
  })
  const actor = domainActor(user)
  const [assignments, { choice, vanityDomains }] = await Promise.all([
    runAppEffect(
      "domains.assignments.instance",
      loadInstanceDomainAssignmentsForInstanceEffect(
        data.relayId,
        data.instanceId
      )
    ),
    runAppEffect(
      "domains.instance.vanityDomains",
      Effect.gen(function* () {
        const ownerId = yield* loadResourceOwnerIdEffect({
          relayId: data.relayId,
          resourceId: data.instanceId,
          resourceType: "instance",
        })
        // Its owner's, the person's own, and Kiln's: the ones it may use.
        const [owners, own] = yield* Effect.all(
          [
            listUsableVanityDomainsEffect(ownerId),
            listUsableVanityDomainsEffect(actor.id),
          ],
          { concurrency: 2 }
        )
        const usable = new Map<string, { domain: string; platform: boolean }>()
        for (const domain of [...owners, ...own]) {
          if (domain.enabled && vanityDomainUsable(domain, ownerId, actor)) {
            usable.set(domain.domain, {
              domain: domain.domain,
              platform: domain.ownerId === null,
            })
          }
        }
        return {
          choice: yield* chooseVanityDomainEffect(ownerId),
          vanityDomains: [...usable.values()].sort(
            (left, right) =>
              Number(left.platform) - Number(right.platform) ||
              left.domain.localeCompare(right.domain)
          ),
        }
      })
    ),
  ])
  const primary = assignments[0]
  return {
    assignment: primary ? assignmentOverview(primary) : null,
    managedDomain: choice?.domain ?? null,
    /** The vanity domains the person may give it an address under. */
    vanityDomains,
  }
}

/**
 * Points a new domain at a game server. Its first domain becomes its connect
 * address; later ones do when `primary` is set. Needs the game server's
 * network, and a vanity domain it may use: its owner's, the platform's, or
 * the person's own.
 */
export async function createInstanceDomainHandler(
  data: CreateInstanceDomainInput
) {
  const { instance, user } = await loadWritableInstance(
    data.relayId,
    data.instanceId
  )
  // A failed create still leaves a failed row behind, so publish either way.
  return ensuringPromise(
    () =>
      runAppEffect(
        "domains.instance.create",
        withInstanceDomainLock(
          "dns.domain.create",
          [data],
          createInstanceDomainEffect(
            { ...instance, relayId: data.relayId },
            data,
            domainActor(user)
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
        ).pipe(
          Effect.catchTag("HostnameInUseError", (error) =>
            explainHostnameInUseEffect(user, error)
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
  const { instance, user } = await loadWritableInstance(
    scope.relayId,
    scope.instanceId
  )
  // A failed rename can still clear leftover records, so publish either way.
  return ensuringPromise(
    () =>
      runAppEffect(
        "domains.instance.update",
        withInstanceDomainLock(
          "dns.domain.rename",
          [scope],
          updateInstanceDomainEffect(
            { ...instance, relayId: scope.relayId },
            data,
            domainActor(user)
          )
        ).pipe(
          Effect.catchTag("HostnameInUseError", (error) =>
            explainHostnameInUseEffect(user, error)
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
  // Signed in before the lookup, so an ID's existence isn't revealed.
  const user = await requireEligibleResourceUser()
  const assignment = await runAppEffect(
    "domains.assignment.load",
    loadInstanceDomainAssignmentEffect(data.id)
  )
  if (!assignment) return
  const scope = {
    instanceId: assignment.instanceId,
    relayId: assignment.relayId,
  }
  await requireRelayPermission({
    instanceId: scope.instanceId,
    permission: "instance.network.write",
    relayId: scope.relayId,
    user,
  })
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

/**
 * Hands a game server's managed domains to the server that takes its place,
 * as moving a server to another Relay does, and points their records at the
 * new server's address. The old server keeps none and isn't given a new
 * one; the new one is given one only as the old one would have been.
 * Reports how many domains moved.
 */
export const moveInstanceDomainsEffect = Effect.fn("domains.instance.move")(
  function* (
    from: { readonly instanceId: string; readonly relayId: string },
    to: DomainInstance
  ) {
    const moved = yield* withInstanceDomainLock(
      "dns.domain.move",
      [from, { instanceId: to.id, relayId: to.relayId }],
      Effect.flatMap(Database, (database) =>
        // All at once, so a move cut short and run again finds either
        // nothing done or everything done.
        database.transaction("domains.instance.move", () =>
          Effect.gen(function* () {
            const optedOut = yield* loadInstanceDomainOptOutEffect(
              from.relayId,
              from.instanceId
            )
            const count = yield* reassignInstanceDomainsEffect(from, {
              instanceId: to.id,
              relayId: to.relayId,
            })
            yield* setInstanceDomainOptOutEffect(
              from.relayId,
              from.instanceId,
              true
            )
            // Run again, the old server is opted out and has nothing
            // left to move; the new one keeps what the first run gave it.
            if (count > 0 || !optedOut) {
              yield* setInstanceDomainOptOutEffect(to.relayId, to.id, optedOut)
            }
            return count
          })
        )
      )
    )
    yield* invalidateManagedDomainAddressesEffect
    // Its records still point at the old server's address until now, also
    // when a run cut short before this moved them and this run moved none.
    const assigned = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      to.relayId,
      to.id
    )
    if (moved > 0 || assigned.length > 0) {
      yield* provisionInstanceDomainEffect(to)
    }
    publishDomainChange({ instanceId: from.instanceId, relayId: from.relayId })
    publishDomainChange({ instanceId: to.id, relayId: to.relayId })
    return moved
  }
)

// Once the Relay has deleted the game server, so its names stay held while
// it might survive. Every domain is marked first, so one whose records
// Cloudflare refuses to delete is finished by the DNS worker.
export const deleteInstanceDomainEffect = Effect.fn("domains.instance.delete")(
  function* (relayId: string, instanceId: string) {
    const assignments = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      relayId,
      instanceId
    )
    for (const assignment of assignments) {
      yield* markInstanceDomainRemovingEffect(assignment.id)
    }
    yield* invalidateManagedDomainAddressesEffect
    for (const assignment of assignments) {
      yield* deleteAssignmentRecordsEffect(assignment).pipe(
        Effect.tapError((error) =>
          recordInstanceDomainSyncErrorEffect(
            assignment.id,
            `Delete failed: ${error.message}`
          )
        ),
        Effect.ignore
      )
    }
  },
  (effect, relayId, instanceId) =>
    withInstanceDomainLock(
      "dns.domain.delete",
      [{ instanceId, relayId }],
      effect
    )
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
    withInstanceDomainLock(
      "dns.domain.remove",
      [{ instanceId, relayId }],
      effect
    )
)

// A failed provision or removal can leave records behind an assignment that
// isn't active, some whose IDs Kiln never heard back. Delete them before
// choosing a name again, so the new records don't orphan them and they don't
// make the domain's own name look taken.
const releaseRecordsEffect = Effect.fn("domains.instance.releaseRecords")(
  function* (assignment: InstanceDomainAssignment, apiToken: string) {
    yield* deleteLostRecordsEffect(apiToken, assignment)
    const recordIds = assignmentRecordIds(assignment)
    if (recordIds.length === 0) return
    const zoneId = yield* assignmentZoneIdEffect(assignment)
    yield* Effect.all(
      recordIds.map((recordId) =>
        deleteCloudflareRecordEffect(apiToken, zoneId, recordId)
      ),
      { concurrency: "unbounded" }
    )
    yield* clearInstanceDomainRecordsEffect(assignment.id)
  }
)

const deleteAssignmentRecordsEffect = Effect.fn(
  "domains.instance.deleteRecords"
)(function* (assignment: InstanceDomainAssignment) {
  yield* deleteManagedDomainAssignmentEffect(
    assignment,
    yield* assignmentApiTokenEffect(assignment)
  )
})

export const deleteManagedDomainAssignmentEffect = Effect.fn(
  "domains.instance.deleteAssignment"
)(function* (assignment: InstanceDomainAssignment, apiToken: string | null) {
  const recordIds = assignmentRecordIds(assignment)
  if (recordIds.length > 0) {
    if (!apiToken) {
      return yield* domainFailure(
        "Cloudflare credentials are required to remove this managed address"
      )
    }
    const zoneId = yield* assignmentZoneIdEffect(assignment)
    yield* Effect.all(
      recordIds.map((recordId) =>
        deleteCloudflareRecordEffect(apiToken, zoneId, recordId)
      ),
      { concurrency: "unbounded" }
    )
  }
  // Ones an attempt made but never heard back about carry the domain's
  // marker instead of an ID.
  if (apiToken) yield* deleteLostRecordsEffect(apiToken, assignment)
  yield* deleteInstanceDomainAssignmentEffect(assignment)
  yield* invalidateManagedDomainAddressesEffect
})

export const removeRelayManagedDomainsEffect = Effect.fn(
  "domains.relay.removeAssignments"
)(function* (relayId: string, removeCloudflareRecords: boolean) {
  const assignments = yield* loadRelayInstanceDomainAssignmentsEffect(relayId)
  if (!removeCloudflareRecords) {
    yield* deleteRelayInstanceDomainAssignmentsEffect(relayId)
    yield* invalidateManagedDomainAddressesEffect
    return assignments.length
  }
  // Marked first, so a delete that fails, or one cut short, is finished by
  // the DNS worker; none is forgotten while Cloudflare still has it.
  yield* markRelayInstanceDomainsRemovingEffect(relayId)
  yield* invalidateManagedDomainAddressesEffect
  yield* Effect.forEach(
    assignments,
    (listed) =>
      withInstanceDomainLock(
        "dns.domain.removeRelay",
        [listed],
        Effect.gen(function* () {
          // As it is now: a move may have taken it off this Relay first.
          const assignment = yield* loadInstanceDomainAssignmentEffect(
            listed.id
          )
          if (
            assignment?.relayId !== relayId ||
            assignment.instanceId !== listed.instanceId
          ) {
            return
          }
          yield* deleteAssignmentRecordsEffect(assignment).pipe(
            Effect.tapError((error) =>
              recordInstanceDomainSyncErrorEffect(
                assignment.id,
                `Delete failed: ${error.message}`
              )
            ),
            Effect.ignore
          )
        })
      ),
    { concurrency: 4, discard: true }
  )
  return assignments.length
})

/**
 * Brings a game server's domains in line with its endpoint, retries failed
 * ones, and gives a server without any its first domain. Reports whether
 * anything changed.
 */
export const provisionInstanceDomainEffect = Effect.fn(
  "domains.instance.provision"
)(
  function* (instance: DomainInstance) {
    if (!instance.publicHost || !instance.publicPort) return false
    // Most installs never connect Cloudflare; they stop here.
    if (!(yield* anyDomainConnectionEffect())) return false
    const assignments = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      instance.relayId,
      instance.id
    )
    if (assignments.length === 0) {
      // A game server whose last domain was removed doesn't get a new one.
      // Its other domains still follow it below, since someone kept or added
      // them, and ones being deleted are left to their delete.
      if (
        yield* loadInstanceDomainOptOutEffect(instance.relayId, instance.id)
      ) {
        return false
      }
      const ownerId = yield* loadResourceOwnerIdEffect({
        relayId: instance.relayId,
        resourceId: instance.id,
        resourceType: "instance",
      })
      const domain = yield* chooseVanityDomainEffect(ownerId)
      if (!domain) return false
      const { apiToken, blacklistPatterns } =
        yield* loadDomainConnectionCredentialEffect(domain.connectionId)
      const vanityLabel = yield* availableVanityLabelEffect(
        { apiToken, blacklistPatterns },
        domain,
        generateVanityCandidates(blacklistPatterns)
      )
      yield* provisionVanityRecordsEffect(apiToken, instance, domain, {
        id: randomUUID(),
        insert: true,
        primary: true,
        vanityLabel,
      }).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
      return true
    }

    const srvConfiguration = managedDomainSrvConfiguration(instance)
    let changed = false
    // Brings one domain in line with the endpoint. Reports whether it changed.
    const reconcileOne = Effect.fnUntraced(function* (
      listed: InstanceDomainAssignment
    ) {
      // Left to its delete, which the DNS worker finishes.
      if (listed.status === "removing") return false
      let assignment = listed
      // A rename under way finishes first, then its records follow the
      // endpoint like any other's.
      if (listed.next) {
        yield* applyInstanceDomainRenameEffect(listed, instance)
        const renamed = yield* loadInstanceDomainAssignmentEffect(listed.id)
        if (!renamed) return true
        assignment = renamed
      }
      if (assignment.status === "active") {
        if (
          managedDomainEndpointMatches(assignment, instance) &&
          domainSrvConfigurationMatches(assignment, srvConfiguration)
        ) {
          if (!assignment.lastError) return assignment !== listed
          yield* clearInstanceDomainErrorEffect(assignment.id)
          return true
        }
        const apiToken = yield* assignmentApiTokenEffect(assignment)
        yield* syncVanityEndpointEffect(apiToken, assignment, instance)
        return true
      }
      const apiToken = yield* assignmentApiTokenEffect(assignment)
      yield* releaseRecordsEffect(assignment, apiToken)
      const domain = yield* configuredDomainEffect(assignment.domain, true)
      const { blacklistPatterns } = yield* loadDomainConnectionCredentialEffect(
        domain.connectionId
      )
      // The primary was likely named by Kiln, so it may take a new name;
      // other domains were named by hand and keep theirs.
      const candidates = assignment.primary
        ? [
            ...new Set([
              assignment.vanityLabel,
              ...generateVanityCandidates(blacklistPatterns),
            ]),
          ]
        : [assignment.vanityLabel]
      const vanityLabel = yield* availableVanityLabelEffect(
        { apiToken, blacklistPatterns },
        domain,
        candidates,
        assignment
      ).pipe(
        Effect.tapError((error) =>
          recordInstanceDomainErrorEffect(assignment.id, error.message)
        )
      )
      yield* provisionVanityRecordsEffect(apiToken, instance, domain, {
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
    withInstanceDomainLock(
      "dns.domain.provision",
      [{ instanceId: instance.id, relayId: instance.relayId }],
      effect
    )
)

const createInstanceDomainEffect = Effect.fn("domains.instance.create")(
  function* (
    instance: DomainInstance,
    input: Pick<
      CreateInstanceDomainInput,
      "domain" | "primary" | "vanityLabel"
    >,
    actor: DomainActor
  ) {
    if (!instance.publicHost || !instance.publicPort) {
      return yield* domainFailure(
        "Update this Relay before assigning a vanity address"
      )
    }
    const domain = yield* configuredDomainEffect(input.domain)
    yield* requireUsableDomainEffect(instance, domain, actor)
    const { apiToken, blacklistPatterns } =
      yield* loadDomainConnectionCredentialEffect(domain.connectionId)
    // The domain's owner may choose a reserved name; Kiln never generates one.
    const chosenPatterns = ownsVanityDomain(domain, actor)
      ? []
      : blacklistPatterns
    if (
      input.vanityLabel !== undefined &&
      !vanityLabelAllowed(input.vanityLabel, chosenPatterns)
    ) {
      return yield* DomainConfigurationError.make({
        message: `${input.vanityLabel}.${domain.domain} is reserved`,
      })
    }
    const existing = yield* loadInstanceDomainAssignmentsForInstanceEffect(
      instance.relayId,
      instance.id
    )
    const vanityLabel = yield* input.vanityLabel === undefined
      ? availableVanityLabelEffect(
          { apiToken, blacklistPatterns },
          domain,
          generateVanityCandidates(blacklistPatterns)
        )
      : availableVanityLabelEffect(
          { apiToken, blacklistPatterns: chosenPatterns },
          domain,
          [input.vanityLabel]
        )
    const id = randomUUID()
    // Promoted only once its records exist, so a failed create leaves the
    // current connect address alone.
    const overview = yield* provisionVanityRecordsEffect(
      apiToken,
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
    >,
    actor: DomainActor
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
    // Renaming within a disabled domain is fine; moving onto one isn't.
    const domain = yield* configuredDomainEffect(
      input.domain,
      input.domain === assignment.domain
    )
    if (input.domain !== assignment.domain) {
      yield* requireUsableDomainEffect(instance, domain, actor)
    }
    const [{ apiToken, blacklistPatterns }, currentToken] = yield* Effect.all(
      [
        loadDomainConnectionCredentialEffect(domain.connectionId),
        assignmentApiTokenEffect(assignment),
      ],
      { concurrency: 2 }
    )
    // The domain's owner may choose a reserved name.
    const credential = {
      apiToken,
      blacklistPatterns: ownsVanityDomain(domain, actor)
        ? []
        : blacklistPatterns,
    }
    if (!vanityLabelAllowed(input.vanityLabel, credential.blacklistPatterns)) {
      return yield* DomainConfigurationError.make({
        message: `${input.vanityLabel}.${domain.domain} is reserved`,
      })
    }
    const renameEffect = Effect.fnUntraced(function* (
      assignment: InstanceDomainAssignment
    ) {
      const renamed =
        assignment.domain !== domain.domain ||
        assignment.vanityLabel !== input.vanityLabel
      if (!renamed) {
        if (assignment.status === "active") {
          return managedDomainEndpointMatches(assignment, instance)
            ? assignmentOverview(assignment)
            : assignmentOverview(
                yield* syncVanityEndpointEffect(
                  currentToken,
                  assignment,
                  instance
                )
              )
        }
        yield* releaseRecordsEffect(assignment, currentToken)
        return yield* provisionVanityRecordsEffect(apiToken, instance, domain, {
          id: assignment.id,
          insert: false,
          primary: assignment.primary,
          vanityLabel: input.vanityLabel,
        })
      }
      yield* availableVanityLabelEffect(
        credential,
        domain,
        [input.vanityLabel],
        assignment
      )
      yield* beginInstanceDomainRenameEffect({
        domain: domain.domain,
        id: assignment.id,
        vanityLabel: input.vanityLabel,
      })
      const renaming = yield* loadInstanceDomainAssignmentEffect(assignment.id)
      if (!renaming) return yield* domainFailure("Domain not found")
      const current = managedDomainEndpointMatches(renaming, instance)
        ? renaming
        : yield* syncVanityEndpointEffect(currentToken, renaming, instance)
      return yield* applyInstanceDomainRenameEffect(current, instance)
    })
    const update = Effect.gen(function* () {
      if (!assignment.next) return yield* renameEffect(assignment)
      // A rename still under way finishes before another starts, so no
      // name its records may be under is let go early.
      yield* applyInstanceDomainRenameEffect(assignment, instance)
      const finished = yield* loadInstanceDomainAssignmentEffect(assignment.id)
      if (!finished) return yield* domainFailure("Domain not found")
      return yield* renameEffect(finished)
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

const provisionVanityRecordsEffect = Effect.fn(
  "domains.instance.createRecords"
)(function* (
  apiToken: string,
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
        connectionId: domain.connectionId,
        instanceId: instance.id,
        primary: target.primary,
        relayId: instance.relayId,
      })
    : reserveInstanceDomainAssignmentEffect({
        ...reservation,
        connectionId: domain.connectionId,
      })
  const hostname = `${vanityLabel}.${domain.domain}`
  const address = cloudflareAddressRecord(hostname, publicHost)
  const addressRecord = yield* createCloudflareAddressRecordEffect(
    apiToken,
    domain.zoneId,
    address,
    domainRecordComment(instance.id, id)
  ).pipe(
    Effect.tapError((error) =>
      recordInstanceDomainErrorEffect(id, error.message)
    )
  )
  const srvRecord =
    supportsSrv && srvProtocol && srvService
      ? yield* createCloudflareSrvRecordEffect(
          apiToken,
          domain.zoneId,
          srvRecordInput(
            hostname,
            publicPort,
            srvService,
            srvProtocol,
            address.type === "CNAME" ? publicHost : hostname
          ),
          domainRecordComment(instance.id, id)
        ).pipe(
          Effect.catch((error) =>
            deleteCloudflareRecordEffect(
              apiToken,
              domain.zoneId,
              addressRecord.id
            ).pipe(
              Effect.catch(() => Effect.void),
              Effect.andThen(
                recordInstanceDomainErrorEffect(id, error.message)
              ),
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
          apiToken,
          domain.zoneId,
          addressRecord.id
        ).pipe(Effect.catch(() => Effect.void)),
        srvRecord
          ? deleteCloudflareRecordEffect(
              apiToken,
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
    apiToken: string,
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
          apiToken,
          zoneId,
          addressRecordId,
          address,
          domainRecordComment(assignment.instanceId, assignment.id)
        )
      } else {
        const replacement = yield* replaceCloudflareAddressRecordEffect(
          apiToken,
          zoneId,
          addressRecordId,
          address,
          domainRecordComment(assignment.instanceId, assignment.id)
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
              apiToken,
              zoneId,
              assignment.srvRecordId,
              srvRecordInput(
                hostname,
                publicPort,
                srvConfiguration.service,
                srvConfiguration.protocol,
                srvTarget
              ),
              domainRecordComment(assignment.instanceId, assignment.id)
            )).id
          : (yield* createCloudflareSrvRecordEffect(
              apiToken,
              zoneId,
              srvRecordInput(
                hostname,
                publicPort,
                srvConfiguration.service,
                srvConfiguration.protocol,
                srvTarget
              ),
              domainRecordComment(assignment.instanceId, assignment.id)
            )).id
        : null
      if (!srvConfiguration && assignment.srvRecordId) {
        yield* deleteCloudflareRecordEffect(
          apiToken,
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

/**
 * Finishes a domain's rename: moves its records to the new name within
 * their zone, or, across zones or without records, makes them anew there,
 * then takes the new name as its own and lets go of the old one. The old
 * name stays held until then, so a rename that fails, or is cut short by a
 * restart, is finished by running it again, as the DNS worker does. Without
 * the game server, as while its Relay is away, only a rename within the
 * zone can finish.
 */
const applyInstanceDomainRenameEffect = Effect.fn(
  "domains.instance.applyRename"
)(function* (
  assignment: InstanceDomainAssignment,
  instance: DomainInstance | null
) {
  const next = assignment.next
  if (!next) return assignmentOverview(assignment)
  const hostname = `${next.vanityLabel}.${next.domain}`
  const apply = Effect.gen(function* () {
    const domain = yield* configuredDomainEffect(next.domain, true)
    const currentToken = yield* assignmentApiTokenEffect(assignment)
    if (
      assignment.status === "active" &&
      assignment.zoneId === domain.zoneId &&
      assignment.integrationId === domain.connectionId
    ) {
      yield* renameVanityRecordsEffect(currentToken, assignment, hostname)
      return yield* finishInstanceDomainRenameEffect(assignment.id)
    }
    if (!instance) {
      return yield* domainFailure("Waiting for the game server's Relay")
    }
    const { apiToken } = yield* loadDomainConnectionCredentialEffect(
      domain.connectionId
    )
    // Records can't move between zones: replace them in the new one.
    yield* releaseRecordsEffect(assignment, currentToken)
    yield* provisionVanityRecordsEffect(apiToken, instance, domain, {
      id: assignment.id,
      insert: false,
      primary: assignment.primary,
      vanityLabel: next.vanityLabel,
    })
  })
  yield* apply.pipe(
    Effect.tapError((error) =>
      recordInstanceDomainSyncErrorEffect(
        assignment.id,
        `Renaming to ${hostname} failed: ${error.message}`
      ).pipe(Effect.ignore)
    ),
    Effect.mapError((error) =>
      ExternalServiceError.make({
        message: `${hostname} isn't ready yet: ${error.message}. Kiln will keep trying.`,
        service: "Cloudflare",
      })
    )
  )
  const updated = yield* loadInstanceDomainAssignmentEffect(assignment.id)
  if (!updated) return yield* domainFailure("The vanity address disappeared")
  return assignmentOverview(updated)
})

/** Points a domain's records at a new name within their zone. */
const renameVanityRecordsEffect = Effect.fn("domains.instance.renameRecords")(
  function* (
    apiToken: string,
    assignment: InstanceDomainAssignment,
    hostname: string
  ) {
    const addressRecordId = assignment.addressRecordId
    if (!addressRecordId) {
      return yield* domainFailure(
        "The managed address is missing its Cloudflare record"
      )
    }
    const zoneId = yield* assignmentZoneIdEffect(assignment)
    yield* updateCloudflareAddressRecordEffect(
      apiToken,
      zoneId,
      addressRecordId,
      cloudflareAddressRecord(hostname, assignment.publicHost),
      domainRecordComment(assignment.instanceId, assignment.id)
    )
    if (
      assignment.supportsSrv &&
      assignment.srvRecordId &&
      assignment.srvService &&
      assignment.srvProtocol
    ) {
      yield* updateCloudflareSrvRecordEffect(
        apiToken,
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
        domainRecordComment(assignment.instanceId, assignment.id)
      )
    }
  }
)

/**
 * Deletes records an attempt made under a domain's name but never saved the
 * IDs of, as when Hearth stopped before Cloudflare answered: Kiln marked
 * them as this game server's, and the name is its own.
 */
const deleteLostRecordsEffect = Effect.fn("domains.instance.deleteLost")(
  function* (apiToken: string, assignment: InstanceDomainAssignment) {
    if (!assignment.zoneId) return
    const zoneId = assignment.zoneId
    const hostname = `${assignment.vanityLabel}.${assignment.domain}`
    const names = [
      hostname,
      ...(assignment.srvService && assignment.srvProtocol
        ? [`_${assignment.srvService}._${assignment.srvProtocol}.${hostname}`]
        : []),
    ]
    const marker = domainRecordMarker(assignment.id)
    for (const name of names) {
      const records = yield* listCloudflareRecordsEffect(apiToken, zoneId, name)
      for (const record of records) {
        if (record.comment?.includes(marker)) {
          yield* deleteCloudflareRecordEffect(apiToken, zoneId, record.id)
        }
      }
    }
  }
)

/**
 * The first candidate no game server or app holds and Cloudflare has no
 * record for. `assignment` is the domain being renamed or retried, whose own
 * names, current and next, aren't taken.
 */
const availableVanityLabelEffect = Effect.fn("domains.instance.availableLabel")(
  function* (
    credential: { apiToken: string; blacklistPatterns: Array<string> },
    domain: ManagedDomain,
    candidates: Array<string>,
    assignment?: InstanceDomainAssignment
  ) {
    const claimed = yield* loadClaimedLabelsEffect(domain.domain)
    const own = new Set(assignment ? assignmentHostnames(assignment) : [])
    const holder = (label: string) =>
      own.has(`${label}.${domain.domain}`) ? null : (claimed.get(label) ?? null)
    // A name the person chose says why it can't be had.
    const [chosen] = candidates
    if (candidates.length === 1 && chosen !== undefined) {
      const hostname = `${chosen}.${domain.domain}`
      if (!vanityLabelAllowed(chosen, credential.blacklistPatterns)) {
        return yield* DomainConfigurationError.make({
          message: `${hostname} is reserved`,
        })
      }
      const held = holder(chosen)
      if (held) {
        return yield* HostnameInUseError.make({
          holder: held,
          hostname,
          message: `${hostname} is already in use`,
        })
      }
      // Its own name may already have its records, mid-rename.
      if (
        !own.has(hostname) &&
        !(yield* cloudflareHostnameAvailableEffect(
          credential.apiToken,
          domain.zoneId,
          hostname
        ))
      ) {
        return yield* HostnameInUseError.make({
          holder: null,
          hostname,
          message: `${hostname} is already in use`,
        })
      }
      return chosen
    }
    for (const candidate of candidates) {
      if (
        holder(candidate) ||
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
      "Kiln could not find an available vanity address"
    )
  }
)

/**
 * Works through game servers' due domain work: deletes to finish, renames
 * cut short, and domains that failed, once their retry is due. Domains that
 * still need work wait twice as long each time, up to an hour. Reports how
 * many game servers it worked on.
 */
export const reconcileDueInstanceDomainsEffect = Effect.fn(
  "domains.instance.reconcileDue"
)(function* (now: number) {
  const due = yield* listDueInstanceDomainsEffect(now)
  for (const server of due) {
    yield* reconcileInstanceDomainWorkEffect(server).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `Domain work for game server ${server.instanceId} failed`,
          cause
        )
      )
    )
    yield* deferInstanceDomainsEffect(server.relayId, server.instanceId, now)
    publishDomainChange(server)
  }
  return due.length
})

const reconcileInstanceDomainWorkEffect = Effect.fnUntraced(function* (server: {
  instanceId: string
  relayId: string
}) {
  const reported = relayConnectionSnapshot(server.relayId)?.instances.find(
    (instance) => instance.id === server.instanceId
  )
  const instance = reported ? { ...reported, relayId: server.relayId } : null
  // Deletes, and renames within a zone, need only what Kiln recorded.
  yield* withInstanceDomainLock(
    "dns.domain.reconcile",
    [server],
    Effect.gen(function* () {
      const assignments = yield* loadInstanceDomainAssignmentsForInstanceEffect(
        server.relayId,
        server.instanceId
      )
      for (const assignment of assignments) {
        if (assignment.status === "removing") {
          yield* deleteAssignmentRecordsEffect(assignment).pipe(
            Effect.tapError((error) =>
              recordInstanceDomainSyncErrorEffect(
                assignment.id,
                `Delete failed: ${error.message}`
              )
            ),
            Effect.ignore
          )
        } else if (assignment.next && !instance) {
          yield* applyInstanceDomainRenameEffect(assignment, null).pipe(
            Effect.ignore
          )
        }
      }
    })
  )
  if (instance) yield* provisionInstanceDomainEffect(instance)
})

/**
 * A configured domain. Only enabled ones take new game server domains;
 * `existing` also accepts a disabled one a game server domain is already on.
 */
const configuredDomainEffect = Effect.fnUntraced(function* (
  name: string,
  existing = false
) {
  const domain = yield* loadManagedDomainEffect(name)
  if (!domain) {
    return yield* domainFailure(`${name} is not a configured vanity domain`)
  }
  return domain.enabled || existing
    ? domain
    : yield* domainFailure(`${name} isn't taking new game server domains`)
})

/** Refuses a vanity domain the game server's owner and the person can't use. */
const requireUsableDomainEffect = Effect.fnUntraced(function* (
  instance: DomainInstance,
  domain: ManagedDomain,
  actor: DomainActor
) {
  const ownerId = yield* loadResourceOwnerIdEffect({
    relayId: instance.relayId,
    resourceId: instance.id,
    resourceType: "instance",
  })
  if (!vanityDomainUsable(domain, ownerId, actor)) {
    return yield* domainFailure(
      `${domain.domain} is not a configured vanity domain`
    )
  }
})

/** The token of the connection whose zone holds an assignment's records. */
const assignmentApiTokenEffect = Effect.fnUntraced(function* (
  assignment: InstanceDomainAssignment
) {
  const credential = yield* loadDomainConnectionCredentialEffect(
    assignment.integrationId
  )
  return credential.apiToken
})

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

export function assignmentOverview(
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
  return { instance: relayInstanceSchema.parse(instance), user }
}

async function requiredRelay(id: string): Promise<PersistedRelay> {
  return activeRelay(id)
}

/**
 * The note on a record Kiln makes for a game server domain. Its marker is the
 * domain's own ID, which stays the same when the game server moves, so a
 * record Kiln never heard back about is found again either way.
 */
function domainRecordComment(instanceId: string, assignmentId: string) {
  return `Managed by Kiln for server ${instanceId} (${domainRecordMarker(assignmentId)})`
}

function domainRecordMarker(assignmentId: string) {
  return `kiln:${assignmentId}`
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
