import { randomUUID } from "node:crypto"

import type { RelayInstance } from "@workspace/contracts"
import { relayInstanceSchema, relaySnapshotSchema } from "@workspace/contracts"
import { Clock, Effect, Result } from "effect"
import { z } from "zod"

import {
  cloudflareAddressRecord,
  cloudflareHostnameAvailableEffect,
  createCloudflareSrvRecordEffect,
  createCloudflareWebRecordEffect,
  deleteCloudflareRecordEffect,
  isCloudflareAddressRecordType,
  kilnRecordComment,
  listCloudflareRecordsEffect,
  listCloudflareZonesEffect,
  replaceCloudflareWebRecordEffect,
  updateCloudflareSrvRecordEffect,
  updateCloudflareWebRecordEffect,
} from "@/effect/cloudflare-api"
import {
  activateAddressEffect,
  addressHostnames,
  adoptWebHostnameRecordEffect,
  assignmentOf,
  beginInstanceDomainRenameEffect,
  clearAddressErrorEffect,
  clearAddressRecordEffect,
  clearAddressRecordsEffect,
  clearAddressSrvEffect,
  deferAddressesEffect,
  deleteAddressEffect,
  deleteRelayAddressesEffect,
  finishInstanceDomainRenameEffect,
  insertInstanceDomainAssignmentEffect,
  insertWebHostnameEffect,
  listAddressesEffect,
  listDueAddressResourcesEffect,
  listResourceAddressesEffect,
  loadActiveInstanceDomainAssignmentsEffect,
  loadAddressEffect,
  loadInstanceDomainAssignmentsForInstanceEffect,
  loadInstanceDomainOptOutEffect,
  markAddressesRemovingEffect,
  markRelayAddressesRemovingEffect,
  markResourceAddressesRemovingEffect,
  markWebHostnameExternalEffect,
  reassignAddressesEffect,
  recordAddressErrorEffect,
  renameTakingNameEffect,
  reserveInstanceDomainAssignmentEffect,
  reviveWebHostnamesEffect,
  saveAddressRecordEffect,
  setAddressPendingEffect,
  setAddressStandaloneEffect,
  setInstanceDomainOptOutEffect,
  setInstanceDomainPrimaryEffect,
  setWebHostnamesProxiedEffect,
  setWebHostnamesRoutedEffect,
  stopGameAddressEffect,
  type Address,
  type ExistingWebRecord,
  type GameEndpoint,
  type WebHostname,
  type WebHostnameResource,
} from "@/effect/addresses"
import { Database } from "@/effect/database"
import {
  anyDomainConnectionEffect,
  listDomainConnectionsEffect,
  listUsableVanityDomainsEffect,
  loadDomainConnectionCredentialEffect,
  loadDomainConnectionEffect,
  loadManagedDomainEffect,
  updateDomainConnectionZonesEffect,
  type DomainConnection,
  type ManagedDomain,
} from "@/effect/domains"
import {
  DomainConfigurationError,
  ExternalServiceError,
  HostnameInUseError,
} from "@/effect/errors"
import {
  canonicalHostname,
  loadClaimedLabelsEffect,
  loadHostnameHolderEffect,
  sameOwner,
} from "@/effect/hostname-claims"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  invalidateCached,
  readThroughCache,
  type CachePolicy,
} from "@/lib/cache"
import { dnsKey, withDnsChange } from "@/lib/dns-operations"
import {
  domainHasActiveSrvRecord,
  hostPortAddress,
  managedDomainConnectAddress,
  managedDomainEndpointMatches,
} from "@/lib/domain-address"
import { publishDomainChange } from "@/lib/domain-realtime.server"
import { domainInZone } from "@/lib/domain-schemas"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayJsonEffect } from "@/lib/relay-client"
import { relayConnectionSnapshot } from "@/lib/relay-connection"
import type { FleetRelayInstance } from "@/lib/relay-fleet"
import type { PersistedRelay } from "@/lib/relay-registry"
import { activeRelay } from "@/lib/relay-registry"
import { exclusive } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireEligibleResourceUser } from "@/server/auth"
import {
  chooseVanityDomainEffect,
  domainActor,
  loadResourceOwnerIdEffect,
  ownsVanityDomain,
  vanityDomainUsable,
  type DomainActor,
} from "@/server/domain-access.server"
import {
  explainHostnameInUseEffect,
  requireResourcePermission,
} from "@/server/domain-resource-access.server"
import type {
  CreateInstanceDomainInput,
  InstanceAddressOverview,
  InstanceDomainInput,
  RemoveInstanceDomainInput,
  UpdateInstanceDomainInput,
} from "@/server/domains"
import { vanityLabelAllowed } from "@/server/reserved-names"
import {
  generateVanityCandidates,
  managedDomainSrvConfiguration,
} from "@/server/vanity-names"

// Every hostname an instance holds is an address, and they all work the
// same way here: one row, one address record in Cloudflare, brought in line
// by one reconcile. What a name is used for is the only difference. Through
// Traefik for web routes, its record points at the Relay and may sit behind
// Cloudflare's proxy. Straight to a game server's game port, it points at
// the server's public host, never proxied, with an SRV record when the game
// looks one up. One name can be used both ways: its record is then the game
// port's, and the Relay's Traefik answers web traffic on that same host.

type DomainInstance = RelayInstance & { relayId: string }

// The instance an address belongs to: a game server, unless it is named
// as an App.
const ownerOf = (scope: {
  readonly instanceId: string
  readonly relayId: string
  readonly resourceType?: WebHostnameResource["resourceType"] | undefined
}): WebHostnameResource => ({
  relayId: scope.relayId,
  resourceId: scope.instanceId,
  resourceType: scope.resourceType ?? "instance",
})

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

/**
 * An instance's own addresses, its main one first, and the vanity domains
 * the person may give it another under. A name only its web routes answer
 * on isn't one: it is read with the routes.
 */
export async function getInstanceDomainHandler(data: InstanceDomainInput) {
  const user = await requireEligibleResourceUser()
  const resource = ownerOf(data)
  await requireResourcePermission(user, resource, false)
  const actor = domainActor(user)
  const [rows, { choice, vanityDomains }] = await Promise.all([
    runAppEffect("addresses.resource", listResourceAddressesEffect(resource)),
    runAppEffect(
      "domains.instance.vanityDomains",
      Effect.gen(function* () {
        const ownerId = yield* loadResourceOwnerIdEffect(resource)
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
  const addresses = rows.filter((row) => row.standalone).map(addressOverview)
  return {
    addresses,
    /** Its main address. */
    assignment: addresses[0] ?? null,
    managedDomain: choice?.domain ?? null,
    /** The vanity domains the person may give it an address under. */
    vanityDomains,
  }
}

// Changing an instance's addresses holds its DNS, so two changes to them
// never interleave, and deleting it turns them away.
const addressDns = (resource: WebHostnameResource) =>
  exclusive(dnsKey(resource))
const changingDomains = "Changing its addresses"

const audited = (resource: WebHostnameResource) => ({
  id: resource.resourceId,
  kind: resource.resourceType,
  relayId: resource.relayId,
})

const publishAddressChange = (resource: WebHostnameResource) =>
  publishDomainChange({
    instanceId: resource.resourceId,
    relayId: resource.relayId,
  })

/**
 * Gives an instance a new address of its own, whatever kind it is. A game
 * server's points at its game port; any other's at its Relay, for a web
 * route to answer on. Its first becomes its main address; later ones do
 * when `primary` is set. Needs the instance's network, and a vanity domain
 * it may use: its owner's, the platform's, or the person's own.
 */
export const addInstanceDomain = operation<CreateInstanceDomainInput>()({
  name: "domain.add",
  doing: changingDomains,
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(() => loadWritableFor(person, ownerOf(input)))
      )
    ),
  locks: ({ input }) => [addressDns(ownerOf(input))],
  run: ({ context: instance, input, user }) =>
    Effect.gen(function* () {
      const person = yield* signedIn(user)
      const resource = ownerOf(input)
      const created = yield* createAddressEffect(
        resource,
        instance,
        input,
        domainActor(person)
      ).pipe(
        Effect.catchTag("HostnameInUseError", (error) =>
          explainHostnameInUseEffect(person, error)
        )
      )
      // Adding an address undoes a game server's removal of its last.
      if (resource.resourceType === "instance") {
        yield* setInstanceDomainOptOutEffect(
          input.relayId,
          input.instanceId,
          false
        )
      }
      return created
    }),
  audit: ({ input }) => audited(ownerOf(input)),
  // A failed create still leaves a failed row behind.
  publish: ({ input }) => publishAddressChange(ownerOf(input)),
})

export async function createInstanceDomainHandler(
  data: CreateInstanceDomainInput
) {
  const user = await requireEligibleResourceUser()
  return runOperationPromise(addInstanceDomain, data, { user })
}

// The instance an address is its own of, once the person may change it. A
// name only its web routes answer on isn't one: it follows its routes.
const loadDomainScope = (user: AuthenticatedUser | null, id: string) =>
  Effect.gen(function* () {
    const person = yield* signedIn(user)
    const row = yield* loadAddressEffect(id)
    if (!row?.standalone) return null
    const resource: WebHostnameResource = {
      relayId: row.relayId,
      resourceId: row.resourceId,
      resourceType: row.resourceType,
    }
    yield* promiseEffect(() =>
      requireResourcePermission(person, resource, true)
    )
    return { person, resource }
  })

/**
 * Gives an address another name, or makes it its instance's main one. A
 * web route that answers on it follows it to the new name.
 */
export const renameInstanceDomain = operation<UpdateInstanceDomainInput>()({
  name: "domain.rename",
  doing: changingDomains,
  authorize: ({ input, user }) =>
    Effect.gen(function* () {
      const scope = yield* loadDomainScope(user, input.id)
      if (!scope) return yield* Effect.fail(new Error("Domain not found"))
      const instance = yield* promiseEffect(() =>
        loadWritableFor(scope.person, scope.resource)
      )
      return { ...scope, instance }
    }),
  locks: ({ context }) => [addressDns(context.resource)],
  run: ({ context, input }) =>
    updateAddressEffect(
      context.resource,
      context.instance,
      input,
      context.person
    ).pipe(
      Effect.catchTag("HostnameInUseError", (error) =>
        explainHostnameInUseEffect(context.person, error)
      )
    ),
  audit: ({ context }) => audited(context.resource),
  // A failed rename can still clear leftover records.
  publish: ({ context }) => publishAddressChange(context.resource),
})

export async function updateInstanceDomainHandler(
  data: UpdateInstanceDomainInput
) {
  // Signed in before the lookup, so an ID's existence isn't revealed.
  const user = await requireEligibleResourceUser()
  return runOperationPromise(renameInstanceDomain, data, { user })
}

/**
 * Removes one address. Removing a game server's last keeps it removed:
 * starts, port changes, and Sync skip the server until one is added again.
 */
export const removeInstanceDomain = operation<RemoveInstanceDomainInput>()({
  name: "domain.remove",
  doing: changingDomains,
  authorize: ({ input, user }) => loadDomainScope(user, input.id),
  locks: ({ context }) => (context ? [addressDns(context.resource)] : []),
  run: ({ context, input }) =>
    context
      ? removeInstanceDomainEffect(context.resource, input.id)
      : Effect.void,
  audit: ({ context }) => (context ? audited(context.resource) : null),
  // A failed removal still changes the row.
  publish: ({ context }) => {
    if (context) publishAddressChange(context.resource)
  },
})

export async function removeInstanceDomainHandler(
  data: RemoveInstanceDomainInput
) {
  // Signed in before the lookup, so an ID's existence isn't revealed.
  const user = await requireEligibleResourceUser()
  await runOperationPromise(removeInstanceDomain, data, { user })
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
        // or another active address while the primary is failing.
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

// A token's zones are remembered when it's saved. A hostname in none of them
// lists them again, at most this often per connection, in case a zone was
// added to the token since.
const zoneRefreshIntervalMs = 60_000

/**
 * The public address a Relay's web routes are served at, as it reports it,
 * or its game servers' address, or the address Hearth reaches it at.
 */
const relayPublicHostEffect = Effect.fn("addresses.relayHost")(function* (
  relayId: string
) {
  const snapshot = relayConnectionSnapshot(relayId)
  const reported =
    snapshot?.relay?.publicHost ??
    snapshot?.instances.find((instance) => instance.publicHost)?.publicHost
  if (reported) return reported
  const relay = yield* promiseEffect(() => activeRelay(relayId)).pipe(
    Effect.mapError(() =>
      DomainConfigurationError.make({
        message: "The Relay hasn't reported a public address yet",
      })
    )
  )
  return relay.hostname
})

/** Where a game server is reached, as its Relay reports it. */
function endpointOf(
  instance:
    | Pick<
        RelayInstance,
        | "brickPrimaryPortProtocol"
        | "brickSupportsSrv"
        | "brickType"
        | "game"
        | "publicHost"
        | "publicPort"
      >
    | null
    | undefined
): GameEndpoint | null {
  return instance?.publicHost && instance.publicPort
    ? {
        publicHost: instance.publicHost,
        publicPort: instance.publicPort,
        srv: managedDomainSrvConfiguration(instance),
      }
    : null
}

/** What reconciling a hostname is told about where its instance is. */
interface ReconcileContext {
  /**
   * Where its game server is reached now, for a game server's address;
   * null while its Relay is away, when an address keeps what Kiln recorded.
   */
  endpoint: GameEndpoint | null
  /** Where the Relay answers web traffic. Asked for once. */
  relayHost: Effect.Effect<string, DomainConfigurationError>
  /**
   * Asks Cloudflare about records that look in step, as Sync does, so one
   * deleted there is made again.
   */
  verify: boolean
}

function contextFor(
  resource: WebHostnameResource,
  options: { endpoint?: GameEndpoint | null; verify?: boolean } = {}
): ReconcileContext {
  let host: Result.Result<string, DomainConfigurationError> | undefined
  return {
    endpoint:
      options.endpoint !== undefined
        ? options.endpoint
        : resource.resourceType === "instance"
          ? endpointOf(
              relayConnectionSnapshot(resource.relayId)?.instances.find(
                (instance) => instance.id === resource.resourceId
              )
            )
          : null,
    relayHost: Effect.suspend(() =>
      host
        ? Effect.succeed(host)
        : Effect.result(relayPublicHostEffect(resource.relayId)).pipe(
            Effect.tap((found) =>
              Effect.sync(() => {
                host = found
              })
            )
          )
    ).pipe(
      Effect.flatMap((found) =>
        Result.isSuccess(found)
          ? Effect.succeed(found.success)
          : Effect.fail(found.failure)
      )
    ),
    verify: options.verify ?? false,
  }
}

/** Where a hostname's record should point, and what goes with it. */
interface Desired {
  port: number | null
  proxied: boolean
  srv: GameEndpoint["srv"]
  target: string
}

const srvOf = (row: Address): GameEndpoint["srv"] =>
  row.supportsSrv && row.srvService && row.srvProtocol
    ? { protocol: row.srvProtocol, service: row.srvService }
    : null

// In step: its records are where Kiln last put them, and that is still
// where they belong.
function inStep(row: Address, desired: Desired): boolean {
  if (
    row.status !== "active" ||
    !row.recordId ||
    row.target !== desired.target ||
    row.recordType !==
      cloudflareAddressRecord(row.hostname, desired.target).type
  ) {
    return false
  }
  if (!row.game) return row.srvRecordId === null
  const srv = srvOf(row)
  return (
    row.publicPort === desired.port &&
    (desired.srv
      ? row.srvRecordId !== null &&
        srv?.service === desired.srv.service &&
        srv.protocol === desired.srv.protocol
      : srv === null && row.srvRecordId === null)
  )
}

/**
 * Brings Cloudflare in line with one hostname, whatever it is used for.
 * One marked for removal has its records deleted and is forgotten. A rename
 * under way finishes first. Then its address record is made, or pointed
 * where it belongs: at its game server's public host for a game server's
 * address, never proxied, with the SRV record the game looks up; at the
 * Relay otherwise, proxied or not as its routes ask, with no SRV record. A
 * name Cloudflare already has someone else's record for is left alone; a
 * record Kiln made but never heard back about is taken up again. One that
 * looks in step is left alone too, unless `verify` asks Cloudflare. A
 * failure shows on its row, for the DNS worker to retry, and fails this.
 * Reports whether it had work to do.
 */
const reconcileAddressEffect = Effect.fn("addresses.reconcile")(function* (
  listed: Address,
  context: ReconcileContext
) {
  if (listed.status === "removing") {
    yield* removeAddressEffect(listed)
    return true
  }
  let row = listed
  if (row.next) {
    yield* applyRenameEffect(row)
    const renamed = yield* loadAddressEffect(row.id)
    if (!renamed) return true
    row = renamed
  }
  const worked = row !== listed
  if (!row.game) {
    // Claimed by a save that failed: held, without a record, until a save
    // says the routes use it.
    if (!row.routed && !row.standalone && !row.recordId && !row.srvRecordId) {
      return worked
    }
    // The name a rename is moving an address of its instance to: that
    // address's record is about to be there.
    if (!row.recordId && (yield* renameTakingNameEffect(row))) return worked
  }
  const desired = yield* desiredEffect(row, context)
  if (!context.verify && inStep(row, desired)) {
    // With its Relay away, what failed may be a change only its Relay can
    // tell again: its error stays until then.
    if (!row.lastError || (row.game && !context.endpoint)) return worked
    yield* clearAddressErrorEffect(row.id)
    return true
  }
  yield* syncRecordsEffect(row, desired).pipe(
    Effect.tapError((error) =>
      recordAddressErrorEffect(row.id, error.message).pipe(Effect.ignore)
    )
  )
  return true
})

const desiredEffect = Effect.fnUntraced(function* (
  row: Address,
  context: ReconcileContext
) {
  if (row.game) {
    const endpoint = context.endpoint
    const target = endpoint?.publicHost ?? row.target
    const port = endpoint?.publicPort ?? row.publicPort
    if (!target || !port) {
      const failure = domainFailure(
        "The Relay did not report a public endpoint"
      )
      yield* recordAddressErrorEffect(row.id, failure.message)
      return yield* Effect.fail(failure)
    }
    return {
      port,
      proxied: false,
      srv: endpoint ? endpoint.srv : srvOf(row),
      target,
    } satisfies Desired
  }
  const host = yield* Effect.result(context.relayHost)
  if (Result.isFailure(host)) {
    // Shown on one still waiting for a record, until the Relay reports in.
    if (row.status !== "active") {
      yield* recordAddressErrorEffect(row.id, host.failure.message)
    }
    return yield* Effect.fail(host.failure)
  }
  return {
    port: null,
    proxied: row.proxied,
    srv: null,
    target: host.success,
  } satisfies Desired
})

const syncRecordsEffect = Effect.fnUntraced(function* (
  row: Address,
  desired: Desired
) {
  const zoneId = yield* zoneOfEffect(row)
  const { apiToken } = yield* loadDomainConnectionCredentialEffect(
    row.connectionId
  )
  const comment = recordComment(row)
  const marker = recordMarker(row)
  const record = {
    ...cloudflareAddressRecord(row.hostname, desired.target),
    proxied: desired.proxied,
  }
  // Null when the record is gone from Cloudflare.
  const pointAt = (recordId: string, recordType: string | null) =>
    recordType === record.type
      ? updateCloudflareWebRecordEffect(
          apiToken,
          zoneId,
          recordId,
          record,
          comment
        )
      : replaceCloudflareWebRecordEffect(
          apiToken,
          zoneId,
          recordId,
          record,
          comment
        )
  let addressRecordId: string | null = null
  let made = false
  if (row.recordId) {
    const updated = yield* pointAt(row.recordId, row.recordType)
    // Deleted in Cloudflare meanwhile: make it again below. Any other
    // failure keeps the record Kiln made, to retry.
    if (updated) addressRecordId = updated.id
    else yield* clearAddressRecordEffect(row.id)
  }
  if (!addressRecordId) {
    const existing = yield* listCloudflareRecordsEffect(
      apiToken,
      zoneId,
      row.hostname
    )
    // Made by an attempt that stopped before it saved the record's ID.
    const lost = existing.find((found) => found.comment?.includes(marker))
    if (lost) {
      addressRecordId = (yield* pointAt(lost.id, lost.type))?.id ?? null
    } else if (existing.length > 0) {
      // Players can't be sent to a record Kiln doesn't keep, and nothing on
      // a game server's page takes one over, so its address fails instead.
      if (row.game) {
        return yield* domainFailure(
          `Cloudflare already has a record for ${row.hostname} that Kiln didn't make`
        )
      }
      return yield* markWebHostnameExternalEffect(
        row.id,
        externalRecordMessage(row),
        existingWebRecord(existing)
      )
    }
    if (!addressRecordId) {
      addressRecordId = (yield* createCloudflareWebRecordEffect(
        apiToken,
        zoneId,
        record,
        comment
      )).id
      made = true
    }
  }
  const kept = yield* saveAddressRecordEffect({
    id: row.id,
    recordId: addressRecordId,
    recordType: record.type,
    target: desired.target,
  })
  if (!kept) {
    // Let go while Cloudflare made it, as removing its connection or Relay
    // does: nothing would delete it later.
    if (made) {
      yield* deleteCloudflareRecordEffect(apiToken, zoneId, addressRecordId)
    }
    return
  }
  let srvRecordId: string | null = null
  if (desired.srv && desired.port) {
    const srv = srvRecordInput(
      row.hostname,
      desired.port,
      desired.srv,
      record.type === "CNAME" ? desired.target : row.hostname
    )
    const update = (recordId: string) =>
      updateCloudflareSrvRecordEffect(apiToken, zoneId, recordId, srv, comment)
    let found = row.srvRecordId ? yield* update(row.srvRecordId) : null
    if (!found) {
      const lost = (yield* listCloudflareRecordsEffect(
        apiToken,
        zoneId,
        srv.name
      )).find((listed) => listed.comment?.includes(marker))
      found =
        (lost ? yield* update(lost.id) : null) ??
        (yield* createCloudflareSrvRecordEffect(apiToken, zoneId, srv, comment))
    }
    srvRecordId = found.id
  } else {
    yield* dropSrvRecordEffect(row, apiToken, zoneId)
  }
  yield* activateAddressEffect({
    id: row.id,
    publicPort: desired.port,
    srv: desired.srv,
    srvRecordId,
  })
})

/**
 * Deletes the SRV record of a hostname that shouldn't have one: a game
 * server's address whose game stopped looking one up, or a name that
 * stopped being a game server's address while web routes still use it.
 */
const dropSrvRecordEffect = Effect.fnUntraced(function* (
  row: Address,
  apiToken: string,
  zoneId: string
) {
  if (!row.srvRecordId && !row.srvService) return
  if (row.srvRecordId) {
    yield* deleteCloudflareRecordEffect(apiToken, zoneId, row.srvRecordId)
  }
  if (row.srvService && row.srvProtocol) {
    yield* deleteMarkedRecordsEffect(
      apiToken,
      zoneId,
      srvName(row.hostname, row.srvService, row.srvProtocol),
      recordMarker(row)
    )
  }
  yield* clearAddressSrvEffect(row.id)
})

/**
 * Finishes a rename: moves its records to the new name within their zone,
 * or, across zones or without records, lets them go and takes the new name,
 * for its records to be made anew there. The old name stays held until
 * then, so a rename that fails, or is cut short by a restart, is finished
 * by running it again, as the DNS worker does.
 */
const applyRenameEffect = Effect.fnUntraced(function* (row: Address) {
  const next = row.next
  if (!next) return
  const apply = Effect.gen(function* () {
    const domain = yield* configuredDomainEffect(next.vanityDomain, true)
    const { apiToken } = yield* loadDomainConnectionCredentialEffect(
      row.connectionId
    )
    if (
      row.status === "active" &&
      row.zoneId === domain.zoneId &&
      row.connectionId === domain.connectionId &&
      (yield* renameRecordsEffect(apiToken, row, next.hostname))
    ) {
      return yield* finishInstanceDomainRenameEffect(row.id)
    }
    // Records can't move between zones, and ones Cloudflare no longer has
    // can't move at all: start over under the new name.
    yield* releaseRecordsEffect(row, apiToken)
    yield* reserveInstanceDomainAssignmentEffect({
      connectionId: domain.connectionId,
      domain: domain.domain,
      hostname: next.hostname,
      id: row.id,
      zoneId: domain.zoneId,
    })
  })
  yield* apply.pipe(
    Effect.tapError((error) =>
      recordAddressErrorEffect(
        row.id,
        `Renaming to ${next.hostname} failed: ${error.message}`
      ).pipe(Effect.ignore)
    ),
    Effect.mapError((error) =>
      ExternalServiceError.make({
        message: `${next.hostname} isn't ready yet: ${error.message}. Kiln will keep trying.`,
        service: "Cloudflare",
      })
    ),
    Effect.ensuring(
      row.game ? invalidateManagedDomainAddressesEffect : Effect.void
    )
  )
})

/**
 * Points a hostname's records at a new name within their zone. False when
 * Cloudflare no longer has its address record.
 */
const renameRecordsEffect = Effect.fnUntraced(function* (
  apiToken: string,
  row: Address,
  hostname: string
) {
  if (!row.recordId || !row.zoneId || !row.target) return false
  const comment = recordComment(row)
  const moved = yield* updateCloudflareWebRecordEffect(
    apiToken,
    row.zoneId,
    row.recordId,
    {
      ...cloudflareAddressRecord(hostname, row.target),
      proxied: !row.game && row.proxied,
    },
    comment
  )
  if (!moved) return false
  const srv = srvOf(row)
  if (srv && row.srvRecordId && row.publicPort) {
    yield* updateCloudflareSrvRecordEffect(
      apiToken,
      row.zoneId,
      row.srvRecordId,
      srvRecordInput(
        hostname,
        row.publicPort,
        srv,
        row.recordType === "CNAME" ? row.target : hostname
      ),
      comment
    )
  }
  return true
})

// A failed attempt can leave records behind a hostname that isn't in step,
// some whose IDs Kiln never heard back. Delete them before it takes another
// name, so new records don't orphan them.
const releaseRecordsEffect = Effect.fnUntraced(function* (
  row: Address,
  apiToken: string
) {
  yield* deleteLostRecordsEffect(apiToken, row)
  const recordIds = recordIdsOf(row)
  if (recordIds.length === 0) return
  const zoneId = yield* zoneOfEffect(row)
  for (const recordId of recordIds) {
    yield* deleteCloudflareRecordEffect(apiToken, zoneId, recordId)
  }
  yield* clearAddressRecordsEffect(row.id)
})

/**
 * Deletes a hostname's records and forgets it, letting go of its names.
 * Also any record Kiln made for it but never heard back about, as when a
 * create or a replacement lost its answer: those carry its marker. One
 * Cloudflare refuses stays `removing`, with why, for the DNS worker: its
 * names stay held until its records are gone, and nothing re-creates it.
 */
const removeAddressEffect = Effect.fn("addresses.remove")(function* (
  row: Address
) {
  if (row.status !== "removing") yield* markAddressesRemovingEffect([row.id])
  const remove = Effect.gen(function* () {
    const recordIds = recordIdsOf(row)
    if (row.zoneId) {
      const zoneId = row.zoneId
      const { apiToken } = yield* loadDomainConnectionCredentialEffect(
        row.connectionId
      )
      for (const recordId of recordIds) {
        yield* deleteCloudflareRecordEffect(apiToken, zoneId, recordId)
      }
      yield* deleteLostRecordsEffect(apiToken, row)
    } else if (recordIds.length > 0) {
      yield* zoneOfEffect(row)
    }
    yield* deleteAddressEffect(row)
  })
  yield* remove.pipe(
    Effect.tapError((error) =>
      recordAddressErrorEffect(row.id, `Delete failed: ${error.message}`).pipe(
        Effect.ignore
      )
    ),
    Effect.ensuring(
      row.game ? invalidateManagedDomainAddressesEffect : Effect.void
    )
  )
})

/**
 * Deletes records an attempt made under a hostname's names but never saved
 * the IDs of, as when Hearth stopped before Cloudflare answered: Kiln
 * marked them as this hostname's, and the names are its own.
 */
const deleteLostRecordsEffect = Effect.fnUntraced(function* (
  apiToken: string,
  row: Address
) {
  if (!row.zoneId) return
  const names = [
    row.hostname,
    ...(row.srvService && row.srvProtocol
      ? [srvName(row.hostname, row.srvService, row.srvProtocol)]
      : []),
  ]
  for (const name of names) {
    yield* deleteMarkedRecordsEffect(
      apiToken,
      row.zoneId,
      name,
      recordMarker(row)
    )
  }
})

const deleteMarkedRecordsEffect = Effect.fnUntraced(function* (
  apiToken: string,
  zoneId: string,
  name: string,
  marker: string
) {
  const records = yield* listCloudflareRecordsEffect(apiToken, zoneId, name)
  for (const record of records) {
    if (record.comment?.includes(marker)) {
      yield* deleteCloudflareRecordEffect(apiToken, zoneId, record.id)
    }
  }
})

type ReconcileFailure = Effect.Error<ReturnType<typeof reconcileAddressEffect>>

// Each hostname on its own, so one failing doesn't hold back the rest; the
// first failure is told once they've all had a turn.
const reconcileEachEffect = Effect.fnUntraced(function* (
  rows: ReadonlyArray<Address>,
  context: ReconcileContext
) {
  let changed = false
  let failure: { error: ReconcileFailure } | null = null
  for (const listed of rows) {
    // One before it may have taken it in, as a rename takes the row of a
    // route already on its new name.
    const row: Address | null = changed
      ? yield* loadAddressEffect(listed.id)
      : listed
    if (!row) continue
    const outcome: Result.Result<boolean, ReconcileFailure> =
      yield* Effect.result(reconcileAddressEffect(row, context))
    if (Result.isSuccess(outcome)) changed ||= outcome.success
    else {
      changed = true
      failure ??= { error: outcome.failure }
    }
  }
  return { changed, failure }
})

/**
 * Brings an instance's DNS records in line with what Kiln holds for it, one
 * hostname at a time. It reads them afresh under the instance's lock, so a
 * run that starts late still does what the latest change asked. Failures
 * show on their rows, and the DNS worker retries them. Reports whether any
 * needed work.
 */
export const reconcileResourceAddressesEffect = Effect.fn(
  "addresses.reconcileResource"
)(
  function* (resource: WebHostnameResource) {
    const rows = yield* listResourceAddressesEffect(resource)
    const { changed } = yield* reconcileEachEffect(rows, contextFor(resource))
    if (changed && rows.some((row) => row.game)) {
      yield* invalidateManagedDomainAddressesEffect
    }
    return changed
  },
  (effect, resource) => withDnsChange("dns.address.reconcile", resource, effect)
)

/**
 * Works through instances' due DNS work: deletes to finish, renames cut
 * short, records to make, and ones that failed, once their retry is due.
 * Hostnames that still need work wait twice as long each time, up to an
 * hour. Reports how many instances it worked on.
 */
export const reconcileDueAddressesEffect = Effect.fn("addresses.reconcileDue")(
  function* (now: number) {
    const due = yield* listDueAddressResourcesEffect(now)
    for (const resource of due) {
      yield* reconcileResourceAddressesEffect(resource).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning(
            `DNS work for ${resource.resourceType} ${resource.resourceId} failed`,
            cause
          )
        )
      )
      yield* deferAddressesEffect(resource, now)
    }
    if (due.length > 0) {
      publishWebHostnameChange(due.map((resource) => resource.relayId))
    }
    return due.length
  }
)

/**
 * Brings a game server's addresses in line with where it is reached now,
 * retries failed ones, and gives a server without any its first. `verify`
 * asks Cloudflare about ones that look in step, as Sync does. Reports
 * whether anything changed.
 */
const provisionInstanceDomainEffect = Effect.fn("domains.instance.provision")(
  function* (instance: DomainInstance, verify = false) {
    return yield* withDnsChange(
      "dns.domain.provision",
      ownerOf({ instanceId: instance.id, relayId: instance.relayId }),
      provisionEffect(instance, verify)
    )
  }
)

const provisionEffect = Effect.fnUntraced(function* (
  instance: DomainInstance,
  verify: boolean
) {
  const endpoint = endpointOf(instance)
  if (!endpoint) return false
  // Most installs never connect Cloudflare; they stop here.
  if (!(yield* anyDomainConnectionEffect())) return false
  const resource = ownerOf({
    instanceId: instance.id,
    relayId: instance.relayId,
  })
  const rows = (yield* listResourceAddressesEffect(resource)).filter(
    (row) => row.game
  )
  if (rows.length === 0) {
    // A game server whose last address was removed doesn't get a new
    // one. Its others still follow it below, since someone kept or added
    // them, and ones being deleted are left to their delete.
    if (yield* loadInstanceDomainOptOutEffect(instance.relayId, instance.id)) {
      return false
    }
    const domain = yield* chooseVanityDomainEffect(
      yield* loadResourceOwnerIdEffect(resource)
    )
    if (!domain) return false
    const { apiToken, blacklistPatterns } =
      yield* loadDomainConnectionCredentialEffect(domain.connectionId)
    const vanityLabel = yield* availableVanityLabelEffect(
      { apiToken, blacklistPatterns },
      domain,
      generateVanityCandidates(blacklistPatterns)
    )
    yield* addAddressEffect(resource, endpoint, domain, {
      primary: true,
      vanityLabel,
    })
    return true
  }
  let changed = false
  if (!rows.some((row) => row.primary)) {
    const first = rows.find((row) => row.status !== "removing")
    if (first) {
      yield* setInstanceDomainPrimaryEffect({ ...resource, id: first.id })
      changed = true
    }
  }
  // Ones being deleted are left to their delete, which the DNS worker
  // finishes.
  const outcome = yield* reconcileEachEffect(
    rows.filter((row) => row.status !== "removing"),
    contextFor(resource, { endpoint, verify })
  )
  changed ||= outcome.changed
  if (changed) yield* invalidateManagedDomainAddressesEffect
  if (outcome.failure) return yield* Effect.fail(outcome.failure.error)
  return changed
})

// A new address of an instance's own, with its records: a game server's
// where it is reached, any other's at its Relay.
const addAddressEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  endpoint: GameEndpoint | null,
  domain: ManagedDomain,
  named: { primary: boolean; vanityLabel: string }
) {
  const id = randomUUID()
  const hostname = `${named.vanityLabel}.${domain.domain}`
  if (endpoint) {
    yield* insertInstanceDomainAssignmentEffect({
      connectionId: domain.connectionId,
      domain: domain.domain,
      endpoint,
      hostname,
      id,
      instanceId: resource.resourceId,
      primary: named.primary,
      relayId: resource.relayId,
      zoneId: domain.zoneId,
    })
  } else {
    yield* insertWebHostnameEffect({
      ...resource,
      connectionId: domain.connectionId,
      hostname,
      id,
      primary: named.primary,
      standalone: true,
      vanityDomain: domain.domain,
      zoneId: domain.zoneId,
    })
  }
  return yield* reconciledEffect(
    id,
    contextFor(resource, endpoint ? { endpoint } : {})
  ).pipe(Effect.ensuring(invalidateManagedDomainAddressesEffect))
})

// A hostname once its records are in step, or why they aren't.
const reconciledEffect = Effect.fnUntraced(function* (
  id: string,
  context: ReconcileContext
) {
  const row = yield* loadAddressEffect(id)
  if (!row) return yield* domainFailure("The vanity address could not be saved")
  yield* reconcileAddressEffect(row, context)
  const after = yield* loadAddressEffect(id)
  if (!after) return yield* domainFailure("The vanity address disappeared")
  return after
})

/**
 * The name a new address takes under a vanity domain: the one someone asked
 * for, once it may be had (not reserved, unless they own the domain, and
 * free), or without one, a name Kiln makes.
 */
const chosenLabelEffect = Effect.fnUntraced(function* (
  domain: ManagedDomain,
  actor: DomainActor,
  vanityLabel: string | undefined
) {
  const { apiToken, blacklistPatterns } =
    yield* loadDomainConnectionCredentialEffect(domain.connectionId)
  if (vanityLabel === undefined) {
    return yield* availableVanityLabelEffect(
      { apiToken, blacklistPatterns },
      domain,
      generateVanityCandidates(blacklistPatterns)
    )
  }
  // The domain's owner may choose a reserved name; Kiln never generates one.
  const chosenPatterns = ownsVanityDomain(domain, actor)
    ? []
    : blacklistPatterns
  if (!vanityLabelAllowed(vanityLabel, chosenPatterns)) {
    return yield* DomainConfigurationError.make({
      message: `${vanityLabel}.${domain.domain} is reserved`,
    })
  }
  return yield* availableVanityLabelEffect(
    { apiToken, blacklistPatterns: chosenPatterns },
    domain,
    [vanityLabel]
  )
})

/** Where players reach a game server; null for any other kind. */
const gameEndpointEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  instance: RelayInstance | null
) {
  if (resource.resourceType !== "instance") return null
  const endpoint = endpointOf(instance)
  return (
    endpoint ??
    (yield* domainFailure(
      "Update this Relay before assigning a vanity address"
    ))
  )
})

const createAddressEffect = Effect.fn("domains.instance.create")(function* (
  resource: WebHostnameResource,
  instance: RelayInstance | null,
  input: Pick<CreateInstanceDomainInput, "domain" | "primary" | "vanityLabel">,
  actor: DomainActor
) {
  const endpoint = yield* gameEndpointEffect(resource, instance)
  const domain = yield* configuredDomainEffect(input.domain)
  yield* requireUsableDomainEffect(resource, domain, actor)
  const existing = (yield* listResourceAddressesEffect(resource)).filter(
    (row) => row.standalone
  )
  const vanityLabel = yield* chosenLabelEffect(domain, actor, input.vanityLabel)
  // Promoted only once its records exist, so a failed create leaves the
  // instance's main address alone.
  const created = yield* addAddressEffect(resource, endpoint, domain, {
    primary: existing.length === 0,
    vanityLabel,
  })
  if (input.primary && existing.length > 0) {
    yield* setInstanceDomainPrimaryEffect({ ...resource, id: created.id }).pipe(
      Effect.ensuring(invalidateManagedDomainAddressesEffect)
    )
  }
  return addressOverview({
    ...created,
    primary: created.primary || input.primary,
  })
})

const updateAddressEffect = Effect.fn("domains.instance.update")(function* (
  resource: WebHostnameResource,
  instance: RelayInstance | null,
  input: Pick<
    UpdateInstanceDomainInput,
    "domain" | "id" | "primary" | "vanityLabel"
  >,
  person: AuthenticatedUser
) {
  const row = yield* loadAddressEffect(input.id)
  if (!row?.standalone || !sameOwner(row, resource)) {
    return yield* domainFailure("Domain not found")
  }
  if (row.status === "removing") {
    return yield* domainFailure("Finish deleting this domain before editing it")
  }
  // Renaming within a disabled domain is fine; moving onto one isn't.
  const domain = yield* configuredDomainEffect(
    input.domain,
    input.domain === row.vanityDomain
  )
  const actor = domainActor(person)
  if (input.domain !== row.vanityDomain) {
    yield* requireUsableDomainEffect(resource, domain, actor)
  }
  const { apiToken, blacklistPatterns } =
    yield* loadDomainConnectionCredentialEffect(domain.connectionId)
  // The domain's owner may choose a reserved name.
  const credential = {
    apiToken,
    blacklistPatterns: ownsVanityDomain(domain, actor) ? [] : blacklistPatterns,
  }
  if (!vanityLabelAllowed(input.vanityLabel, credential.blacklistPatterns)) {
    return yield* DomainConfigurationError.make({
      message: `${input.vanityLabel}.${domain.domain} is reserved`,
    })
  }
  const renamed = {
    credential,
    domain,
    person,
    vanityLabel: input.vanityLabel,
  }
  const updated = row.game
    ? yield* renameGameAddressEffect(
        resource,
        yield* gameEndpointEffect(resource, instance),
        row,
        renamed
      )
    : yield* renameWebAddressEffect(resource, row, renamed)
  if (input.primary && !updated.primary) {
    yield* setInstanceDomainPrimaryEffect({ ...resource, id: updated.id }).pipe(
      Effect.ensuring(invalidateManagedDomainAddressesEffect)
    )
  }
  if (updated.stranded) {
    return yield* DomainConfigurationError.make({ message: updated.stranded })
  }
  return addressOverview({
    ...updated,
    primary: updated.primary || input.primary,
  })
})

interface Renamed {
  /** The domain's token, and the names reserved against this person. */
  credential: { apiToken: string; blacklistPatterns: Array<string> }
  domain: ManagedDomain
  person: AuthenticatedUser
  vanityLabel: string
}

/**
 * Has an instance's web routes answer on the name its address took, in
 * place of the one it left, by saving them as its Network page does: its
 * Relay, the names it holds and their records all follow.
 */
const followRoutesEffect = (
  person: AuthenticatedUser,
  resource: WebHostnameResource,
  change: { from: string; proxied: boolean; to: string }
) =>
  promiseEffect(async () => {
    // Saving routes needs this module, so it is asked for when it's used.
    const { moveWebRouteHostname } = await import("@/server/web-routes.server")
    await moveWebRouteHostname(person, resource, change)
  })

/**
 * Renames a game server's address in place: its record and SRV record move
 * to the new name by their IDs, so the name players join at is never
 * without them. The old name stays held until Cloudflare has the new one.
 * A web route that answered on the old name is then saved onto the new one,
 * and the old name let go. When that save fails the rename stands: the
 * route keeps the old name, with a record of its own, and `stranded` says
 * so.
 */
const renameGameAddressEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  endpoint: GameEndpoint | null,
  row: Address,
  { credential, domain, person, vanityLabel }: Renamed
) {
  const hostname = `${vanityLabel}.${domain.domain}`.toLowerCase()
  const context = contextFor(resource, { endpoint })
  let left: Address | null = null
  const update = Effect.gen(function* () {
    // A rename still under way finishes before another starts, so no name
    // its records may be under is let go early.
    const current = row.next ? yield* reconciledEffect(row.id, context) : row
    if (current.hostname !== hostname) {
      yield* availableVanityLabelEffect(
        credential,
        domain,
        [vanityLabel],
        current
      )
      yield* beginInstanceDomainRenameEffect({
        domain: domain.domain,
        id: current.id,
        vanityLabel,
      })
      left = current
    }
    return yield* reconciledEffect(row.id, context)
  })
  const updated = yield* update.pipe(
    Effect.ensuring(invalidateManagedDomainAddressesEffect)
  )
  const previous = left as Address | null
  const followed =
    previous?.routed && updated.hostname === hostname
      ? yield* Effect.result(
          followRoutesEffect(person, resource, {
            from: previous.hostname,
            proxied: false,
            to: hostname,
          })
        )
      : null
  // A name it left stays its routes' while they answer on it, and gets its
  // own record, pointed at the Relay. A failure shows on its row, and the
  // DNS worker retries it.
  yield* reconcileEachEffect(
    (yield* listResourceAddressesEffect(resource)).filter(
      (other) => !other.game
    ),
    context
  )
  return {
    ...((yield* loadAddressEffect(row.id)) ?? updated),
    stranded:
      previous && followed && Result.isFailure(followed)
        ? `${hostname} is its address now, but its web route still answers on ${previous.hostname}: ${failureMessage(followed.failure)}`
        : null,
  }
})

/**
 * Renames an address that isn't a game server's by making the new one and
 * letting the old one go, so its record never points nowhere on the way:
 * the new name gets its record, a web route that answered on the old name
 * is saved onto the new one, and only then is the old name removed. A name
 * its own routes already hold becomes the address as it is.
 *
 * When the routes can't be saved nothing is renamed: the old name is as it
 * was, and the new one is no address. It stays held, without a record, the
 * way a name a failed save of the routes claimed does, since the Relay may
 * have taken the routes even so; trying again takes it up.
 */
const renameWebAddressEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  row: Address,
  { credential, domain, person, vanityLabel }: Renamed
) {
  const hostname = `${vanityLabel}.${domain.domain}`.toLowerCase()
  if (hostname === row.hostname) return { ...row, stranded: null }
  const held = (yield* listResourceAddressesEffect(resource)).find(
    (other) => other.hostname === hostname && other.status !== "removing"
  )
  if (held && (held.game || held.standalone)) {
    return yield* DomainConfigurationError.make({
      message: `${hostname} is already one of its addresses`,
    })
  }
  const id = held?.id ?? randomUUID()
  if (held) {
    yield* setAddressStandaloneEffect(id, true)
  } else {
    yield* availableVanityLabelEffect(credential, domain, [vanityLabel])
    yield* insertWebHostnameEffect({
      ...resource,
      connectionId: domain.connectionId,
      hostname,
      id,
      standalone: true,
      vanityDomain: domain.domain,
      zoneId: domain.zoneId,
    })
  }
  // The new name stops being an address, and keeps no record nothing
  // answers on. What Cloudflare refuses now, the DNS worker deletes once a
  // save of the routes lets the name go.
  const takeBack = Effect.gen(function* () {
    const made = yield* loadAddressEffect(id)
    if (!made || made.game) return
    if (!made.routed && recordIdsOf(made).length > 0) {
      yield* loadDomainConnectionCredentialEffect(made.connectionId).pipe(
        Effect.flatMap(({ apiToken }) => releaseRecordsEffect(made, apiToken)),
        Effect.ignore
      )
    }
    yield* setAddressStandaloneEffect(id, false)
  })
  yield* reconciledEffect(id, contextFor(resource)).pipe(
    Effect.tapError(() =>
      // Nothing was asked of the Relay: a name made for this goes whole.
      held
        ? takeBack
        : loadAddressEffect(id).pipe(
            Effect.flatMap((made) =>
              made ? removeAddressEffect(made) : Effect.void
            ),
            Effect.ignore
          )
    )
  )
  if (row.routed) {
    yield* followRoutesEffect(person, resource, {
      from: row.hostname,
      proxied: row.proxied,
      to: hostname,
    }).pipe(
      Effect.tapError(() => takeBack),
      Effect.mapError((cause) =>
        DomainConfigurationError.make({
          message: `Its web route couldn't be moved to ${hostname}, so nothing was renamed: ${failureMessage(cause)}`,
        })
      )
    )
  }
  if (row.primary) {
    yield* setInstanceDomainPrimaryEffect({ ...resource, id })
  }
  // One Cloudflare refuses to delete shows on its row as it goes, and the
  // DNS worker finishes it.
  yield* markAddressesRemovingEffect([row.id])
  yield* removeAddressEffect({ ...row, status: "removing" }).pipe(Effect.ignore)
  const renamed = yield* loadAddressEffect(id)
  if (!renamed) return yield* domainFailure("The vanity address disappeared")
  return { ...renamed, stranded: null }
})

const failureMessage = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause)

// Removes one of an instance's own addresses, under its lock.
const removeOwnAddressEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  id: string
) {
  const rows = (yield* listResourceAddressesEffect(resource)).filter(
    (row) => row.standalone
  )
  const row = rows.find((item) => item.id === id)
  if (!row) return
  // Only a game server's address can leave its name to a route: the name
  // then stops being where players join. Any other is the route's address,
  // and let go under it, the name could go to someone else while the route
  // still answered on it.
  if (!row.game && row.routed && row.status !== "removing") {
    return yield* DomainConfigurationError.make({
      message: `A web route uses ${row.hostname}. Remove it from the routes first.`,
    })
  }
  const remaining = rows.filter(
    (item) => item.id !== id && item.status !== "removing"
  )
  if (remaining.length === 0 && resource.resourceType === "instance") {
    yield* setInstanceDomainOptOutEffect(
      resource.relayId,
      resource.resourceId,
      true
    )
  }
  // Another address takes over as the main one before Cloudflare is
  // touched, so it moves even if the delete fails.
  const successor =
    remaining.find((item) => item.status === "active") ?? remaining[0]
  if (row.primary && successor) {
    yield* setInstanceDomainPrimaryEffect({ ...resource, id: successor.id })
  }
  if (row.game && row.routed && row.status !== "removing") {
    yield* stopGameAddressEffect(row)
    yield* invalidateManagedDomainAddressesEffect
    // Its record is its routes' from here: a failure shows on its row,
    // and the DNS worker retries it.
    const kept = yield* loadAddressEffect(id)
    if (kept) {
      yield* reconcileAddressEffect(kept, contextFor(resource)).pipe(
        Effect.ignore
      )
    }
    return
  }
  // Keep the removal. Cloudflare deletes are idempotent, so deleting
  // again finishes it; until then the address shows as failing to delete,
  // Hearth stops advertising it, and nothing re-creates it.
  yield* markAddressesRemovingEffect([id])
  yield* invalidateManagedDomainAddressesEffect
  yield* removeAddressEffect({ ...row, status: "removing" })
})

/**
 * Stops a name being one of its instance's own addresses. Its records are
 * deleted and the name let go. A game server's whose web routes still
 * answer on it leaves the name to them, pointed at the Relay, without its
 * SRV record; any other that a web route answers on is refused, until the
 * route is removed or answers elsewhere.
 */
export const removeInstanceDomainEffect = Effect.fn("domains.instance.remove")(
  removeOwnAddressEffect,
  (effect, resource) => withDnsChange("dns.domain.remove", resource, effect)
)

/**
 * The first candidate no instance holds and Cloudflare has no record for.
 * `renaming` is the address being renamed or retried, whose own names,
 * current and next, aren't taken.
 */
const availableVanityLabelEffect = Effect.fn("domains.instance.availableLabel")(
  function* (
    credential: { apiToken: string; blacklistPatterns: Array<string> },
    domain: ManagedDomain,
    candidates: Array<string>,
    renaming?: Address
  ) {
    const claimed = yield* loadClaimedLabelsEffect(domain.domain)
    const own = new Set(renaming ? addressHostnames(renaming) : [])
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
 * A configured domain. Only enabled ones take new addresses; `existing`
 * also accepts a disabled one an address is already on.
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

/** Refuses a vanity domain the instance's owner and the person can't use. */
const requireUsableDomainEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  domain: ManagedDomain,
  actor: DomainActor
) {
  const ownerId = yield* loadResourceOwnerIdEffect(resource)
  if (!vanityDomainUsable(domain, ownerId, actor)) {
    return yield* domainFailure(
      `${domain.domain} is not a configured vanity domain`
    )
  }
})

/** Where Kiln may create a hostname's record. */
interface HostnameZone {
  connectionId: string
  /** The vanity domain it's a name under, when it is one. */
  vanityDomain: string | null
  zoneId: string
}

/**
 * The connection and zone Kiln may make `hostname`'s record in for an
 * instance owned by `ownerId`, or null if none. A single name under a
 * vanity domain the instance may use goes there; anything else needs a zone
 * on the person's own connections, its owner's when they are the owner, or
 * the platform's when they're an administrator.
 */
const resolveHostnameZoneEffect = Effect.fn("addresses.resolve")(function* (
  hostname: string,
  ownerId: string | null,
  actor: DomainActor
) {
  const dot = hostname.indexOf(".")
  const label = hostname.slice(0, dot)
  const vanity =
    dot > 0 ? yield* loadManagedDomainEffect(hostname.slice(dot + 1)) : null
  if (vanity && vanityDomainUsable(vanity, ownerId, actor)) {
    if (!vanity.enabled) {
      return yield* DomainConfigurationError.make({
        message: `${vanity.domain} isn't taking new addresses`,
      })
    }
    const { blacklistPatterns } = yield* loadDomainConnectionCredentialEffect(
      vanity.connectionId
    )
    if (
      !ownsVanityDomain(vanity, actor) &&
      !vanityLabelAllowed(label, blacklistPatterns)
    ) {
      return yield* DomainConfigurationError.make({
        message: `${hostname} is reserved by the domain's owner`,
      })
    }
    return {
      connectionId: vanity.connectionId,
      vanityDomain: vanity.domain,
      zoneId: vanity.zoneId,
    } satisfies HostnameZone
  }

  const owners = new Set<string | null>([actor.id])
  if (ownerId !== null && (actor.admin || ownerId === actor.id)) {
    owners.add(ownerId)
  }
  if (actor.admin) owners.add(null)
  const connections = yield* listDomainConnectionsEffect([...owners])
  const found = zoneFor(hostname, connections)
  if (found) return found
  // The zone may have been added to a token since it was saved.
  const now = yield* Clock.currentTimeMillis
  const stale = connections.filter(
    (connection) =>
      !connection.lastVerifiedAt ||
      now - Date.parse(connection.lastVerifiedAt) > zoneRefreshIntervalMs
  )
  if (stale.length === 0) return null
  const refreshed = yield* Effect.forEach(
    stale,
    (connection) =>
      loadDomainConnectionCredentialEffect(connection.id).pipe(
        Effect.flatMap((credential) =>
          listCloudflareZonesEffect(credential.apiToken)
        ),
        Effect.tap((zones) =>
          updateDomainConnectionZonesEffect(connection.id, zones)
        ),
        Effect.map((zones) => ({ ...connection, zones })),
        // A token that stopped working keeps what it had.
        Effect.orElseSucceed(() => connection)
      ),
    { concurrency: 4 }
  )
  return zoneFor(hostname, refreshed)
})

/** The connection with the most specific zone holding `hostname`. */
function zoneFor(
  hostname: string,
  connections: ReadonlyArray<DomainConnection>
): HostnameZone | null {
  let best: { name: string; zone: HostnameZone } | null = null
  for (const connection of connections) {
    for (const zone of connection.zones) {
      if (!domainInZone(hostname, zone.name)) continue
      if (best && best.name.length >= zone.name.length) continue
      best = {
        name: zone.name,
        zone: {
          connectionId: connection.id,
          vanityDomain: null,
          zoneId: zone.id,
        },
      }
    }
  }
  return best?.zone ?? null
}

interface ClaimInput {
  actor: DomainActor
  hostnames: ReadonlyArray<string>
  /** Puts some hostnames through Cloudflare's proxy, or takes them out. */
  proxy?: WebHostnameProxyChange
  resource: WebHostnameResource
}

/** Whether some of an instance's hostnames go through Cloudflare's proxy. */
export interface WebHostnameProxyChange {
  hostnames: ReadonlyArray<string>
  proxied: boolean
}

/**
 * Claims the hostnames an instance's web routes are about to use, before
 * they save, so two saves can't both take one. Refuses, without claiming
 * any: one another instance holds, and, under a vanity domain someone else
 * owns (such as one Kiln provides), a reserved name or one Cloudflare
 * already has a record for. Names the instance holds, a game server's
 * addresses included, pass. Returns the rows it claimed, to release if the
 * save fails.
 */
const claimHostnamesEffect = Effect.fn("addresses.claim")(function* (
  input: ClaimInput
) {
  const { actor, resource } = input
  const held = new Map(
    (yield* listResourceAddressesEffect(resource)).map((row) => [
      row.hostname,
      row,
    ])
  )
  const fresh = freshHostnames(input.hostnames, held)
  if (fresh.length === 0) return []
  const ownerId = yield* loadResourceOwnerIdEffect(resource)
  for (const hostname of fresh) {
    const holder = yield* loadHostnameHolderEffect(hostname)
    if (holder) {
      if (sameOwner(holder, resource)) continue
      return yield* HostnameInUseError.make({
        holder,
        hostname,
        message: `${hostname} is already in use`,
      })
    }
    const name = yield* vanityNameEffect(hostname)
    if (
      !name ||
      !vanityDomainUsable(name.domain, ownerId, actor) ||
      ownsVanityDomain(name.domain, actor)
    ) {
      continue
    }
    if (!name.domain.enabled) {
      return yield* DomainConfigurationError.make({
        message: `${name.domain.domain} isn't taking new addresses`,
      })
    }
    const { apiToken, blacklistPatterns } =
      yield* loadDomainConnectionCredentialEffect(name.domain.connectionId)
    if (!vanityLabelAllowed(name.label, blacklistPatterns)) {
      return yield* DomainConfigurationError.make({
        message: `${hostname} is reserved`,
      })
    }
    if (
      !(yield* cloudflareHostnameAvailableEffect(
        apiToken,
        name.domain.zoneId,
        hostname
      ))
    ) {
      return yield* HostnameInUseError.make({
        holder: null,
        hostname,
        message: `${hostname} is already in use`,
      })
    }
  }
  const claimed: Array<Address> = []
  for (const hostname of fresh) {
    const row = yield* claimHostnameEffect(
      resource,
      hostname,
      ownerId,
      actor,
      held
    ).pipe(Effect.tapError(() => releaseClaimsEffect(claimed)))
    if (row) {
      claimed.push(row)
      held.set(row.hostname, row)
    }
  }
  return claimed
})

/**
 * Saves an instance's web routes with `save`, the write that changes them,
 * holding the instance's lock throughout. Claims the hostnames they newly
 * use first, so nothing else takes one before the save settles. Once it
 * saves, hostnames the routes no longer use are marked for removal, keeping
 * their names until their records are gone; one that is also a game
 * server's address only stops being routed. Their DNS records follow in
 * `reconcileResourceAddressesEffect`.
 */
export function saveWebRouteHostnamesEffect<A, E, R>(
  input: ClaimInput,
  save: Effect.Effect<A, E, R>
) {
  return withDnsChange(
    "dns.webRoutes.save",
    input.resource,
    Effect.gen(function* () {
      const proxy = input.proxy && {
        hostnames: [...new Set(input.proxy.hostnames.map(canonicalHostname))],
        proxied: input.proxy.proxied,
      }
      if (proxy?.proxied) yield* refuseProxiedGameAddressEffect(input, proxy)
      // A failed save keeps its claims: the Relay may have taken the
      // routes even so. They get no record until a save says the routes
      // use them, and the next save that doesn't lets them go.
      yield* claimHostnamesEffect(input)
      const saved = yield* save
      const wanted = new Set(input.hostnames.map(canonicalHostname))
      const rows = yield* listResourceAddressesEffect(input.resource)
      const taken = rows.filter(
        (row) => row.status === "removing" && wanted.has(row.hostname)
      )
      yield* reviveWebHostnamesEffect(
        taken.filter((row) => !row.game).map((row) => row.id)
      )
      // A game server's address on its way out stays for the route alone.
      for (const row of taken.filter((row) => row.game)) {
        yield* reviveWebHostnamesEffect([row.id])
        yield* stopGameAddressEffect(row)
      }
      yield* markAddressesRemovingEffect(
        rows
          .filter(
            (row) =>
              // An address of its own outlives its routes.
              !row.standalone &&
              row.status !== "removing" &&
              !wanted.has(row.hostname)
          )
          .map((row) => row.id)
      )
      yield* setWebHostnamesRoutedEffect(input.resource, [...wanted])
      if (proxy) {
        yield* setWebHostnamesProxiedEffect(
          input.resource,
          proxy.hostnames.filter((hostname) => wanted.has(hostname)),
          proxy.proxied
        )
      }
      return saved
    })
  )
}

/**
 * Refuses to proxy a game server's own address, or the name one is being
 * renamed to: players connect to its record directly, and Cloudflare's
 * proxy only carries web traffic.
 */
const refuseProxiedGameAddressEffect = Effect.fnUntraced(function* (
  input: ClaimInput,
  proxy: WebHostnameProxyChange
) {
  const names = new Set(
    (yield* listResourceAddressesEffect(input.resource))
      .filter((row) => row.game)
      .flatMap(addressHostnames)
  )
  const hostname = proxy.hostnames.find((name) => names.has(name))
  if (hostname) {
    return yield* DomainConfigurationError.make({
      message: `${hostname} is this game server's address, which players connect to directly, so it can't go through Cloudflare's proxy`,
    })
  }
})

/**
 * Lets go of claims whose routes never saved: each one nothing has made a
 * record for yet, which under the instance's lock is all of them.
 */
const releaseClaimsEffect = Effect.fnUntraced(function* (
  rows: ReadonlyArray<Address>
) {
  for (const row of rows) {
    const current = yield* loadAddressEffect(row.id)
    if (current && !current.game && !current.recordId) {
      yield* deleteAddressEffect(current)
    }
  }
})

/**
 * Hostnames not yet held, lowercased, each once, names before their `www`
 * counterparts so a counterpart can follow its name.
 */
function freshHostnames(
  hostnames: ReadonlyArray<string>,
  held: ReadonlyMap<string, Address>
): Array<string> {
  return [...new Set(hostnames.map(canonicalHostname))]
    .filter((name) => !held.has(name))
    .sort(
      (left, right) =>
        Number(left.startsWith("www.")) - Number(right.startsWith("www."))
    )
}

/**
 * The vanity domain a hostname is a name under, with that name's label: a
 * single label under it, or the `www` counterpart of one.
 */
const vanityNameEffect = Effect.fnUntraced(function* (hostname: string) {
  const base = hostname.startsWith("www.") ? hostname.slice(4) : null
  for (const name of base ? [hostname, base] : [hostname]) {
    const dot = name.indexOf(".")
    if (dot <= 0) continue
    const domain = yield* loadManagedDomainEffect(name.slice(dot + 1))
    if (domain) return { domain, label: name.slice(0, dot) }
  }
  return null
})

/**
 * The zone a `www` counterpart's record goes in when its name is a vanity
 * name the instance holds.
 */
const counterpartZoneEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  hostname: string,
  held: ReadonlyMap<string, Address>
) {
  if (!hostname.startsWith("www.")) return null
  const baseName = hostname.slice(4)
  const base = held.get(baseName)
  if (base) {
    return base.vanityDomain && base.zoneId
      ? ({
          connectionId: base.connectionId,
          vanityDomain: null,
          zoneId: base.zoneId,
        } satisfies HostnameZone)
      : null
  }
  const holder = yield* loadHostnameHolderEffect(baseName)
  if (!holder || !sameOwner(holder, resource)) return null
  const name = yield* vanityNameEffect(baseName)
  return name
    ? ({
        connectionId: name.domain.connectionId,
        vanityDomain: null,
        zoneId: name.domain.zoneId,
      } satisfies HostnameZone)
    : null
})

/**
 * Holds a hostname for an instance, in the zone Kiln may make its record
 * in. Null when there's none; fails when another instance holds it. A `www`
 * counterpart of a vanity name the instance holds goes in that name's zone.
 * The name a rename is moving one of its addresses to is held here, in that
 * domain's zone, until the rename finishes and the two become one row.
 */
const claimHostnameEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  hostname: string,
  ownerId: string | null,
  actor: DomainActor,
  held: ReadonlyMap<string, Address>
) {
  const holder = yield* loadHostnameHolderEffect(hostname)
  if (holder && !sameOwner(holder, resource)) {
    return yield* HostnameInUseError.make({
      holder,
      hostname,
      message: `${hostname} is already in use`,
    })
  }
  const own = holder ? yield* vanityNameEffect(hostname) : null
  const zone = holder
    ? own && {
        connectionId: own.domain.connectionId,
        vanityDomain: own.domain.domain,
        zoneId: own.domain.zoneId,
      }
    : ((yield* counterpartZoneEffect(resource, hostname, held)) ??
      (yield* resolveHostnameZoneEffect(hostname, ownerId, actor)))
  if (!zone) return null
  const id = randomUUID()
  yield* insertWebHostnameEffect({
    ...resource,
    connectionId: zone.connectionId,
    hostname,
    id,
    standalone: false,
    vanityDomain: zone.vanityDomain,
    zoneId: zone.zoneId,
  })
  return yield* loadAddressEffect(id)
})

/**
 * Gives a new App an address under a vanity domain it may use, as game
 * servers get one, and points it at its Relay. Null when no vanity domain
 * applies.
 */
export const generateAppHostnameEffect = Effect.fn("addresses.generate")(
  function* (resource: WebHostnameResource) {
    const ownerId = yield* loadResourceOwnerIdEffect(resource)
    const domain = yield* chooseVanityDomainEffect(ownerId)
    if (!domain) return null
    const [{ apiToken, blacklistPatterns }, used] = yield* Effect.all(
      [
        loadDomainConnectionCredentialEffect(domain.connectionId),
        loadClaimedLabelsEffect(domain.domain),
      ],
      { concurrency: 2 }
    )
    const context = contextFor(resource)
    yield* context.relayHost
    // Its first address is its main one.
    const first = !(yield* listResourceAddressesEffect(resource)).some(
      (row) => row.standalone
    )
    for (const label of generateVanityCandidates(blacklistPatterns)) {
      if (used.has(label)) continue
      const hostname = `${label}.${domain.domain}`
      const available = yield* cloudflareHostnameAvailableEffect(
        apiToken,
        domain.zoneId,
        hostname
      )
      if (!available) continue
      const id = randomUUID()
      const reserved = yield* insertWebHostnameEffect({
        ...resource,
        connectionId: domain.connectionId,
        hostname,
        id,
        primary: first,
        standalone: true,
        vanityDomain: domain.domain,
        zoneId: domain.zoneId,
      }).pipe(
        Effect.as(true),
        // Taken meanwhile: try the next name.
        Effect.catchTag("HostnameInUseError", () => Effect.succeed(false))
      )
      if (!reserved) continue
      const row = yield* loadAddressEffect(id)
      if (row) yield* reconcileAddressEffect(row, context)
      return hostname
    }
    return yield* DomainConfigurationError.make({
      message: "Kiln could not find an available address",
    })
  },
  (effect, resource) =>
    withDnsChange("dns.appAddress.generate", resource, effect)
)

function externalRecordMessage(row: Address): string {
  return `Cloudflare already has a record for ${row.hostname}. Kiln leaves records it didn't create alone until you let it manage them.`
}

/**
 * The one address record among those Cloudflare has under a name, which
 * Kiln can take over; null when it has none, or several.
 */
function existingWebRecord(
  records: ReadonlyArray<{
    content?: string
    id: string
    proxied?: boolean
    type: string
  }>
): ExistingWebRecord | null {
  const addresses = addressRecords(records)
  return addresses.length === 1 ? (addresses[0] ?? null) : null
}

function addressRecords(
  records: ReadonlyArray<{
    content?: string
    id: string
    proxied?: boolean
    type: string
  }>
): Array<ExistingWebRecord> {
  return records.flatMap(({ content, id, proxied, type }) =>
    isCloudflareAddressRecordType(type)
      ? [{ content: content ?? "", id, proxied: proxied ?? false, type }]
      : []
  )
}

// A person's own connection, or Kiln's for administrators. Being able to
// change an instance's routes isn't enough to take a record someone made in
// a zone that isn't theirs.
function mayAdoptRecords(ownerId: string | null, actor: DomainActor) {
  return ownerId === null ? actor.admin : ownerId === actor.id
}

/**
 * The ones of `rows` whose existing record `actor` may hand to Kiln, by ID,
 * and whether that record already points at the Relay. One that doesn't
 * moves there when it's handed over, so the person needs to know.
 */
export const adoptableWebHostnamesEffect = Effect.fn("addresses.adoptable")(
  function* (rows: ReadonlyArray<WebHostname>, actor: DomainActor) {
    const candidates = rows.filter(
      (row) => row.status === "external" && row.existingRecord !== null
    )
    const adoptable = new Map<string, boolean>()
    const targets = new Map<string, string | null>()
    for (const connectionId of new Set(
      candidates.map((row) => row.connectionId)
    )) {
      const connection = yield* loadDomainConnectionEffect(connectionId)
      if (
        !connection ||
        !mayAdoptRecords(connection.connection.ownerId, actor)
      ) {
        continue
      }
      for (const row of candidates) {
        if (row.connectionId !== connectionId) continue
        let target = targets.get(row.relayId)
        if (target === undefined) {
          target = yield* relayPublicHostEffect(row.relayId).pipe(
            Effect.orElseSucceed(() => null)
          )
          targets.set(row.relayId, target)
        }
        const wanted =
          target === null ? null : cloudflareAddressRecord(row.hostname, target)
        adoptable.set(
          row.id,
          wanted?.type === row.existingRecord?.type &&
            wanted?.content === row.existingRecord?.content
        )
      }
    }
    return adoptable
  }
)

/**
 * Takes over the record Cloudflare already had under a hostname, as its
 * owner confirmed it: the one address record there, `record`, as they saw
 * it. Only the owner of the hostname's Cloudflare connection may: being
 * able to change an instance's routes isn't enough to take a record someone
 * made in a zone that isn't theirs. Kiln then points it at the Relay, marks
 * it as its own, and deletes it with the hostname, as a record it made.
 * Refuses, changing nothing in Cloudflare, when that record is gone or
 * changed, or when the name has several address records; what Kiln shows
 * for it is read again.
 */
export const adoptExistingWebRecordEffect = Effect.fn(
  "addresses.adoptExisting"
)(function* (
  row: WebHostnameResource & { id: string },
  input: { actor: DomainActor; record: ExistingWebRecord }
) {
  yield* withCurrentRow("dns.webRoutes.adopt", row, (current) =>
    Effect.gen(function* () {
      const owner = (yield* loadDomainConnectionEffect(current.connectionId))
        ?.connection.ownerId
      if (owner === undefined || !mayAdoptRecords(owner, input.actor)) {
        return yield* DomainConfigurationError.make({
          message:
            "Only the owner of this domain's Cloudflare connection can allow Kiln to manage its records",
        })
      }
      if (current.status !== "external") {
        return yield* DomainConfigurationError.make({
          message: `Kiln already manages the record for ${current.hostname}`,
        })
      }
      const zoneId = yield* zoneOfEffect(current)
      const { apiToken } = yield* loadDomainConnectionCredentialEffect(
        current.connectionId
      )
      const records = yield* listCloudflareRecordsEffect(
        apiToken,
        zoneId,
        current.hostname
      )
      const addresses = addressRecords(records)
      const found = existingWebRecord(records)
      // The same record can point elsewhere by now: anything other than
      // what they saw needs their say again.
      const confirmed = input.record
      if (
        !found ||
        found.id !== confirmed.id ||
        found.type !== confirmed.type ||
        found.content !== confirmed.content ||
        found.proxied !== confirmed.proxied
      ) {
        if (records.length > 0) {
          yield* markWebHostnameExternalEffect(
            current.id,
            externalRecordMessage(current),
            found
          )
        } else {
          // Gone: the next sync makes Kiln's own.
          yield* setAddressPendingEffect(current.id)
        }
        return yield* DomainConfigurationError.make({
          message:
            records.length === 0
              ? `The record for ${current.hostname} is gone from Cloudflare, so Kiln will create its own.`
              : addresses.length > 1
                ? `Cloudflare has more than one A, AAAA, or CNAME record for ${current.hostname}. Delete the extra ones there first.`
                : found
                  ? `The record for ${current.hostname} changed in Cloudflare. Review it and try again.`
                  : `Cloudflare has no A, AAAA, or CNAME record for ${current.hostname} to take over. Delete its other records there for Kiln to create its own.`,
        })
      }
      yield* adoptWebHostnameRecordEffect({
        id: current.id,
        proxied: found.proxied,
        recordId: found.id,
        recordType: found.type,
      })
    })
  )
  // Pointing it at the Relay can fail like any sync; the row says why and
  // the DNS worker retries it.
  yield* reconcileResourceAddressesEffect(row)
  publishWebHostnameChange([row.relayId])
  return yield* loadAddressEffect(row.id)
})

/**
 * Deletes every record a deleted instance had and lets go of its names.
 * All are marked for removal first, so a delete that fails is finished by
 * the DNS worker. Reports how many it had; fails with the first that
 * couldn't be deleted, once each has had a turn.
 */
export const deleteResourceAddressesEffect = Effect.fn(
  "addresses.deleteResource"
)(
  function* (resource: WebHostnameResource) {
    yield* markResourceAddressesRemovingEffect(resource)
    const rows = yield* listResourceAddressesEffect(resource)
    const { failure } = yield* reconcileEachEffect(
      rows,
      contextFor(resource, { endpoint: null })
    )
    if (rows.some((row) => row.game)) {
      yield* invalidateManagedDomainAddressesEffect
    }
    if (failure) return yield* Effect.fail(failure.error)
    return rows.length
  },
  (effect, resource) => withDnsChange("dns.address.delete", resource, effect)
)

/**
 * Forgets a removed Relay's hostnames, deleting their records first when
 * asked. Reports how many it had.
 */
export const removeRelayAddressesEffect = Effect.fn("addresses.removeRelay")(
  function* (relayId: string, removeRecords: boolean) {
    const rows = yield* listAddressesEffect({ relayId })
    if (!removeRecords) {
      yield* deleteRelayAddressesEffect(relayId)
      yield* invalidateManagedDomainAddressesEffect
      return rows.length
    }
    // Marked first, so one whose delete fails, or is cut short, is finished
    // by the DNS worker; none is forgotten while Cloudflare still has it.
    // Each goes as it is under its instance's lock, still on this Relay,
    // whatever a save or a move under way did to it.
    yield* markRelayAddressesRemovingEffect(relayId)
    yield* invalidateManagedDomainAddressesEffect
    yield* Effect.forEach(
      rows,
      (row) =>
        withCurrentRow("dns.address.removeRelay", row, (current) =>
          current.relayId === relayId
            ? removeAddressEffect(current).pipe(Effect.ignore)
            : Effect.void
        ),
      { concurrency: 4, discard: true }
    )
    return rows.length
  }
)

/**
 * Runs `effect` on a hostname as it is under its instance's lock, so work
 * on it that started first, such as making its record, finishes first.
 * Skips it once it's gone, or moved to another instance.
 */
function withCurrentRow<E, R>(
  kind: string,
  row: WebHostnameResource & { id: string },
  effect: (current: Address) => Effect.Effect<unknown, E, R>
) {
  return withDnsChange(
    kind,
    row,
    Effect.gen(function* () {
      const current = yield* loadAddressEffect(row.id)
      if (current && sameOwner(current, row)) yield* effect(current)
    })
  )
}

/**
 * Hands a game server's addresses to the server that takes its place, as
 * moving a server to another Relay does, and points their records at where
 * the new server is reached. The old server keeps none and isn't given a
 * new one; the new one is given one only as the old one would have been.
 * Reports how many addresses moved.
 */
export const moveInstanceDomainsEffect = Effect.fn("domains.instance.move")(
  function* (
    from: { readonly instanceId: string; readonly relayId: string },
    to: DomainInstance
  ) {
    const source = ownerOf(from)
    const target = ownerOf({ instanceId: to.id, relayId: to.relayId })
    const moved = yield* withDnsChange(
      "dns.domain.move",
      [source, target],
      Effect.flatMap(Database, (database) =>
        // All at once, so a move cut short and run again finds either
        // nothing done or everything done.
        database.transaction("domains.instance.move", () =>
          Effect.gen(function* () {
            const optedOut = yield* loadInstanceDomainOptOutEffect(
              from.relayId,
              from.instanceId
            )
            const count = yield* reassignAddressesEffect(source, target, "game")
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
    // Its records still point at the old server until now, also when a run
    // cut short before this moved them and this run moved none.
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

/**
 * Hands the rest of a game server's hostnames, the ones its web routes
 * answer on, to the one that takes its place, once its routes have moved,
 * and points them at the new Relay.
 */
export const moveResourceWebHostnamesEffect = Effect.fn("addresses.move")(
  function* (from: WebHostnameResource, to: WebHostnameResource) {
    const moved = yield* withDnsChange(
      "dns.webRoutes.move",
      [from, to],
      reassignAddressesEffect(from, to, "rest")
    )
    // Also when a run cut short before this moved them and this run moved
    // none: their records still point at the old Relay until now.
    yield* reconcileResourceAddressesEffect(to)
    publishWebHostnameChange([from.relayId, to.relayId])
    return moved
  }
)

/**
 * Checks every hostname against Cloudflare and brings it in line, retrying
 * failed ones, as Sync asks: a record deleted there is made again, a game
 * server's as a web route's. Game servers Kiln can reach are checked
 * against where they are reached now, and one without an address is given
 * its first; the rest go by what Kiln recorded. Reports how many web
 * hostnames it checked, the first failure among those, and the game servers
 * it couldn't bring in line.
 */
export const resyncAddressesEffect = Effect.fn("addresses.resync")(function* (
  instances: ReadonlyArray<DomainInstance>,
  include: (row: Address) => boolean
) {
  const [, serverFailures] = yield* Effect.partition(
    instances,
    (instance) => provisionInstanceDomainEffect(instance, true),
    { concurrency: 1 }
  )
  const reached = new Set(
    instances.map((instance) => assignmentKey(instance.relayId, instance.id))
  )
  // A game server's address was just checked with its server.
  const left = (row: Address) =>
    include(row) &&
    !(row.game && reached.has(assignmentKey(row.relayId, row.resourceId)))
  const rows = (yield* listAddressesEffect()).filter(include)
  const resources = new Map<string, WebHostnameResource>()
  for (const row of rows.filter(left)) {
    resources.set(`${row.resourceType}:${row.relayId}:${row.resourceId}`, {
      relayId: row.relayId,
      resourceId: row.resourceId,
      resourceType: row.resourceType,
    })
  }
  let failure: string | null = null
  for (const resource of resources.values()) {
    const outcome = yield* withDnsChange(
      "dns.address.resync",
      resource,
      Effect.gen(function* () {
        // Read again under the lock: a save or delete may have released
        // or moved them since the list was read.
        const current = (yield* listResourceAddressesEffect(resource)).filter(
          left
        )
        const checked = yield* reconcileEachEffect(
          current,
          contextFor(resource, { verify: true })
        )
        return checked.failure?.error.message ?? null
      })
    ).pipe(Effect.catch((error) => Effect.succeed(error.message)))
    failure ??= outcome
  }
  yield* invalidateManagedDomainAddressesEffect
  return {
    checked: rows.filter((row) => !row.game || row.routed).length,
    failure,
    serverFailures,
  }
})

function zoneOfEffect(
  row: Pick<Address, "hostname" | "vanityDomain" | "zoneId">
): Effect.Effect<string, ExternalServiceError> {
  return row.zoneId
    ? Effect.succeed(row.zoneId)
    : Effect.fail(
        domainFailure(
          `${row.vanityDomain ?? row.hostname} is no longer a configured vanity domain`
        )
      )
}

function recordIdsOf(row: Address): Array<string> {
  return [row.recordId, row.srvRecordId].filter(
    (recordId): recordId is string => recordId !== null
  )
}

const srvName = (hostname: string, service: string, protocol: string) =>
  `_${service}._${protocol}.${hostname}`

function srvRecordInput(
  hostname: string,
  port: number,
  srv: NonNullable<GameEndpoint["srv"]>,
  target: string
) {
  return {
    name: srvName(hostname, srv.service, srv.protocol),
    port,
    priority: 0,
    target,
    weight: 0,
  }
}

/** One of an instance's own addresses, as its Network page lists it. */
function addressOverview(row: Address): InstanceAddressOverview {
  const assignment = assignmentOf(row)
  return {
    // What players type, for a game server's; its name, for any other.
    address: row.game ? managedDomainConnectAddress(assignment) : row.hostname,
    directAddress: row.game
      ? hostPortAddress(assignment.publicHost, assignment.publicPort)
      : (row.target ?? ""),
    domain: assignment.domain,
    game: row.game,
    hostname: row.hostname,
    id: row.id,
    lastError: row.lastError,
    port: row.game ? assignment.publicPort : null,
    primary: row.primary,
    routed: row.routed,
    srvActive: row.game && domainHasActiveSrvRecord(assignment),
    status: assignment.status,
    supportsSrv: row.game && assignment.supportsSrv,
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

/**
 * Lets someone who may change an instance's addresses through. A game
 * server comes back as its Relay reports it, for where players reach it;
 * any other kind needs only its Relay, and comes back null.
 */
async function loadWritableFor(
  user: AuthenticatedUser,
  resource: WebHostnameResource
): Promise<RelayInstance | null> {
  const relay = await requiredRelay(resource.relayId)
  await requireResourcePermission(user, resource, true)
  if (resource.resourceType !== "instance") return null
  const snapshot = relaySnapshotSchema.parse(
    await runAppEffect(
      "relay.snapshot.domain",
      relayJsonEffect(relay, "/v1/snapshot", (input) => input)
    )
  )
  const instance = snapshot.instances.find(
    (item) => item.id === resource.resourceId
  )
  if (!instance) throw new Error("Instance not found")
  return relayInstanceSchema.parse(instance)
}

async function requiredRelay(id: string): Promise<PersistedRelay> {
  return activeRelay(id)
}

/**
 * The note on a record Kiln makes for a hostname, naming its instance. Its
 * marker is the hostname's own ID, which stays the same when its game
 * server moves, so a record Kiln never heard back about is found again
 * either way.
 */
function recordComment(row: Address): string {
  return kilnRecordComment(
    `${row.resourceType === "app" ? "app" : "server"} ${row.resourceId}`,
    recordMarker(row)
  )
}

function recordMarker(row: Pick<Address, "id">): string {
  return `kiln:${row.id}`
}

function domainFailure(message: string): ExternalServiceError {
  return ExternalServiceError.make({ message, service: "Cloudflare" })
}

export function publishWebHostnameChange(relayIds: ReadonlyArray<string>) {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [...new Set(relayIds)] },
    topics: ["domains"],
    type: "hearth.invalidate",
  })
}
