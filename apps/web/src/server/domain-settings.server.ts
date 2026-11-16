import { randomUUID } from "node:crypto"

import {
  relayProxyConfigurationSchema,
  relayProxyConfigurationV1Feature,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import { listCloudflareZonesEffect } from "@/effect/cloudflare-api"
import {
  addManualDomainEffect,
  deleteDomainConnectionEffect,
  listDomainConnectionsEffect,
  listManualDomainsEffect,
  listUsableVanityDomainsEffect,
  loadDomainConnectionCredentialEffect,
  loadDomainConnectionEffect,
  removeManualDomainEffect,
  requireConnectionUnusedEffect,
  saveDomainConnectionEffect,
  type DomainConnection,
  type ManagedDomain,
} from "@/effect/domains"
import { wakePollingWorker } from "@/lib/polling-worker"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import {
  listWebHostnamesEffect,
  listGameAddressesEffect,
  vanityLabelOf,
  retryAddressesNowEffect,
  webHostnameProxied,
} from "@/effect/addresses"
import { isPlatformAdmin } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { promiseEffect } from "@/effect/promise"
import {
  domainHasActiveSrvRecord,
  managedDomainConnectAddress,
} from "@/lib/domain-address"
import { publishDomainChange } from "@/lib/domain-realtime.server"
import {
  domainInZone,
  domainNameSchema,
  validateBlacklistPatterns,
} from "@/lib/domain-schemas"
import { kilnRootDomain } from "@/lib/environment"
import { listInstanceDirectoryEffect } from "@/lib/instance-directory"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { activeRelay, listPersistedRelays } from "@/lib/relay-registry"
import { relayJsonEffect } from "@/lib/relay-client"
import { requireEligibleResourceUser } from "@/server/auth"
import { resourceAccess } from "@/server/domain-resource-access.server"
import { outsideOperation } from "@/operations/current"
import { exclusive, partKey } from "@/operations/lanes"
import {
  operation,
  runOperationPromise,
  signedIn,
} from "@/operations/operation"
import { requireFastReservedPatterns } from "@/server/reserved-names"
import {
  attachManualHostnamesEffect,
  invalidateManagedDomainAddressesEffect,
  resyncAddressesEffect,
  type RoutedHostname,
} from "@/server/addresses.server"
import { pendingWebCertificate } from "@/server/web-certificates.server"
import type {
  DeleteDomainConnectionInput,
  DiscoverDomainsInput,
  ManagedDomainOverview,
  ManualDomainOverview,
  SaveDomainConnectionInput,
  WebHostnameOverview,
} from "@/server/domains"

/** Whether a person may see and change a connection. */
function canManageConnection(
  user: AuthenticatedUser,
  connection: Pick<DomainConnection, "ownerId">
): boolean {
  return connection.ownerId === null
    ? isPlatformAdmin(user)
    : connection.ownerId === user.id
}

/**
 * The Domains page: the person's Cloudflare connections (and the
 * platform's, for administrators), the vanity domains they may use, and the
 * game server domains and web hostnames on what they can read. Hearth's own
 * tables only, so the page never waits on a Relay or Cloudflare.
 */
export async function getDomainSettingsHandler() {
  const user = await requireEligibleResourceUser()
  const admin = isPlatformAdmin(user)
  const [
    connections,
    usable,
    assignments,
    hostnames,
    relays,
    directory,
    apps,
    access,
  ] = await Promise.all([
    runAppEffect(
      "domains.connections.list",
      listDomainConnectionsEffect(admin ? [null, user.id] : [user.id])
    ),
    runAppEffect(
      "domains.domains.usable",
      listUsableVanityDomainsEffect(user.id)
    ),
    runAppEffect("domains.assignments.all", listGameAddressesEffect()),
    runAppEffect("webHostnames.list", listWebHostnamesEffect()),
    listPersistedRelays(),
    runAppEffect("instances.directory.list", listInstanceDirectoryEffect()),
    runAppEffect("apps.list", listAppRecordsEffect()),
    resourceAccess(user),
  ])
  const resources = resourceDirectory(relays, directory, apps)
  const zoneNames = new Map<string, string>()
  const connectionNames = new Map<string, string>()
  for (const domain of usable) zoneNames.set(domain.domain, domain.zoneName)
  for (const connection of connections) {
    connectionNames.set(connection.id, connection.name)
    for (const domain of connection.domains) {
      zoneNames.set(domain.domain, domain.zoneName)
    }
  }
  const visibleAssignments = assignments.filter((assignment) =>
    access.instance(assignment.relayId, assignment.resourceId, false)
  )
  const domainCounts = new Map<string, number>()
  for (const assignment of visibleAssignments) {
    const key = serverKey(assignment.relayId, assignment.resourceId)
    domainCounts.set(key, (domainCounts.get(key) ?? 0) + 1)
  }
  const managedDomains = visibleAssignments.map(
    (assignment): ManagedDomainOverview => {
      const key = serverKey(assignment.relayId, assignment.resourceId)
      const server = resources.server(assignment.relayId, assignment.resourceId)
      return {
        address: managedDomainConnectAddress(assignment),
        canManage: access.instance(
          assignment.relayId,
          assignment.resourceId,
          true
        ),
        domain: assignment.vanityDomain ?? "",
        domainCount: domainCounts.get(key) ?? 1,
        id: assignment.id,
        instanceId: assignment.resourceId,
        lastError: assignment.lastError,
        port: assignment.publicPort ?? 0,
        primary: assignment.primary,
        relayId: assignment.relayId,
        relayName: resources.relayName(assignment.relayId),
        server: {
          brickId: server?.brickId,
          game: server?.game,
          implementation: server?.implementation,
          name: server?.name ?? assignment.resourceId,
        },
        srvActive: domainHasActiveSrvRecord(assignment),
        status: assignment.status === "external" ? "error" : assignment.status,
        supportsSrv: assignment.supportsSrv,
        vanityLabel: vanityLabelOf(
          assignment.hostname,
          assignment.vanityDomain
        ),
        zoneName: zoneNames.get(assignment.vanityDomain ?? "") ?? null,
      }
    }
  )

  const webHostnames = hostnames.flatMap((row): Array<WebHostnameOverview> => {
    const isApp = row.resourceType === "app"
    const readable = isApp
      ? access.app(row.relayId, row.resourceId, false)
      : access.instance(row.relayId, row.resourceId, false)
    if (!readable) return []
    const canManage = isApp
      ? access.app(row.relayId, row.resourceId, true)
      : access.instance(row.relayId, row.resourceId, true)
    return [
      {
        // The listed connections are the person's to manage.
        canAdopt:
          canManage &&
          row.connectionId !== null &&
          row.status === "external" &&
          row.existingRecord !== null &&
          connectionNames.has(row.connectionId),
        canManage,
        certificate: pendingWebCertificate(row, row.hostname),
        connectionName:
          row.connectionId === null
            ? null
            : (connectionNames.get(row.connectionId) ?? null),
        existingRecord: row.status === "external" ? row.existingRecord : null,
        generated: row.generated,
        hostname: row.hostname,
        id: row.id,
        lastError: row.lastError,
        // A name managed elsewhere has no record of Kiln's to proxy.
        proxied: row.connectionId === null ? null : webHostnameProxied(row),
        relayId: row.relayId,
        routed: row.routed,
        relayName: resources.relayName(row.relayId),
        resource: resources.webResource(
          row.resourceType,
          row.relayId,
          row.resourceId
        ),
        // Under a domain managed elsewhere: held by Kiln, pointed by hand.
        status:
          row.connectionId === null && row.status !== "removing"
            ? "manual"
            : row.status,
        target: row.target,
        vanity: row.vanityDomain !== null && row.connectionId !== null,
        zoneName:
          row.connectionId === null
            ? null
            : (zoneNameFor(row.hostname, connections, row.connectionId) ??
              (row.vanityDomain
                ? (zoneNames.get(row.vanityDomain) ?? null)
                : null)),
      },
    ]
  })

  const platformDomains = usable
    .filter((domain) => domain.ownerId === null && domain.enabled)
    .map((domain) => ({ domain: domain.domain, isDefault: domain.isDefault }))

  // Domains managed elsewhere: the person's, and Kiln's for administrators.
  const manualNames = new Map<string, number>()
  for (const row of hostnames) {
    if (row.connectionId === null && row.vanityDomain) {
      manualNames.set(
        row.vanityDomain,
        (manualNames.get(row.vanityDomain) ?? 0) + 1
      )
    }
  }
  const manualDomains = (
    await runAppEffect(
      "domains.manual.list",
      listManualDomainsEffect(admin ? [null, user.id] : [user.id])
    )
  ).map((domain): ManualDomainOverview => ({
    domain: domain.domain,
    names: manualNames.get(domain.domain) ?? 0,
    platform: domain.ownerId === null,
  }))

  return {
    canManagePlatform: admin,
    connections: connections.map(publicConnection),
    hearthDomain: kilnRootDomain(),
    managedDomains,
    manualDomains,
    platformDomains,
    userId: user.id,
    webHostnames,
  }
}

/**
 * Web route hostnames Kiln keeps no record for, as each Relay's proxy serves
 * them: names outside every connected zone, which their owners point at the
 * Relay by hand. A separate read from the page's, so a slow or offline Relay
 * only delays its own rows.
 */
export async function getManualWebHostnamesHandler(): Promise<
  Array<WebHostnameOverview>
> {
  const user = await requireEligibleResourceUser()
  const [hostnames, relays, directory, apps, access] = await Promise.all([
    runAppEffect("webHostnames.list", listWebHostnamesEffect()),
    listPersistedRelays(),
    runAppEffect("instances.directory.list", listInstanceDirectoryEffect()),
    runAppEffect("apps.list", listAppRecordsEffect()),
    resourceAccess(user),
  ])
  const resources = resourceDirectory(relays, directory, apps)
  const kept = new Set(hostnames.map((row) => row.hostname))
  const perRelay = await readRelayRoutes(relays)
  const seen = new Set<string>()
  return perRelay.flatMap((route): Array<WebHostnameOverview> => {
    const hostname = route.hostname.toLowerCase()
    const { id, kind } = route.owner
    const key = `${route.relayId}:${kind}:${id}:${hostname}`
    // One row per name, however many paths route it.
    if (kept.has(hostname) || seen.has(key)) return []
    seen.add(key)
    const isApp = kind === "app"
    const readable = isApp
      ? access.app(route.relayId, id, false)
      : access.instance(route.relayId, id, false)
    if (!readable) return []
    return [
      {
        canManage: isApp
          ? access.app(route.relayId, id, true)
          : access.instance(route.relayId, id, true),
        certificate: pendingWebCertificate(
          {
            relayId: route.relayId,
            resourceId: id,
            resourceType: isApp ? "app" : "instance",
          },
          hostname
        ),
        canAdopt: false,
        connectionName: null,
        existingRecord: null,
        generated: false,
        hostname,
        id: key,
        lastError: null,
        proxied: null,
        relayId: route.relayId,
        routed: true,
        relayName: resources.relayName(route.relayId),
        resource: resources.webResource(
          isApp ? "app" : "instance",
          route.relayId,
          id
        ),
        status: "manual",
        target: null,
        vanity: false,
        zoneName: null,
      },
    ]
  })
}

/**
 * The web routes each Relay's proxy serves, every path of every name. An
 * unreachable Relay's are left out, to wait for the next read.
 */
async function readRelayRoutes(relays: ReadonlyArray<{ id: string }>): Promise<
  Array<{
    hostname: string
    owner: { id: string; kind: string }
    relayId: string
  }>
> {
  const perRelay = await Promise.all(
    relays
      .filter((relay) =>
        relayConnectionFeatures(relay.id).has(relayProxyConfigurationV1Feature)
      )
      .map((relay) =>
        recoverPromise(
          async () => {
            const { routes } = relayProxyConfigurationSchema.parse(
              await relayRpc(
                await activeRelay(relay.id),
                "relay.proxy.config.read",
                {},
                5_000
              )
            )
            return routes.map((route) => ({ ...route, relayId: relay.id }))
          },
          () => []
        )
      )
  )
  return perRelay.flat()
}

type InstanceDirectoryRecord = Effect.Success<
  ReturnType<typeof listInstanceDirectoryEffect>
>[number]

/** Names and links for the game servers and apps the page's rows point at. */
function resourceDirectory(
  relays: ReadonlyArray<{ id: string; name: string }>,
  directory: ReadonlyArray<InstanceDirectoryRecord>,
  apps: ReadonlyArray<{ appId: string; name: string; relayId: string }>
) {
  const relayNames = new Map(relays.map((relay) => [relay.id, relay.name]))
  const servers = new Map(
    directory.map((record) => [serverKey(record.relayId, record.id), record])
  )
  const appsByKey = new Map(
    apps.map((app) => [serverKey(app.relayId, app.appId), app])
  )
  const server = (relayId: string, instanceId: string) =>
    servers.get(serverKey(relayId, instanceId))
  return {
    relayName: (relayId: string) => relayNames.get(relayId) ?? "Unknown Relay",
    server,
    webResource(
      resourceType: "app" | "instance",
      relayId: string,
      resourceId: string
    ): WebHostnameOverview["resource"] {
      if (resourceType === "app") {
        const app = appsByKey.get(serverKey(relayId, resourceId))
        return {
          id: resourceId,
          kind: "app",
          name: app?.name ?? resourceId,
        }
      }
      const record = server(relayId, resourceId)
      return {
        brickId: record?.brickId,
        id: resourceId,
        implementation: record?.implementation,
        kind: "server",
        name: record?.name ?? resourceId,
      }
    },
  }
}

/** Hides nothing secret; the token never leaves Hearth. */
function publicConnection(connection: DomainConnection) {
  return {
    blacklistPatterns: connection.blacklistPatterns,
    domains: connection.domains,
    id: connection.id,
    lastError: connection.lastError,
    lastVerifiedAt: connection.lastVerifiedAt,
    name: connection.name,
    platform: connection.ownerId === null,
    zones: connection.zones,
  }
}

function zoneNameFor(
  hostname: string,
  connections: ReadonlyArray<DomainConnection>,
  connectionId: string
): string | null {
  const connection = connections.find((item) => item.id === connectionId)
  let best: string | null = null
  for (const zone of connection?.zones ?? []) {
    if (
      domainInZone(hostname, zone.name) &&
      zone.name.length > (best?.length ?? 0)
    ) {
      best = zone.name
    }
  }
  return best
}

// Saving a Cloudflare connection holds its settings, so two saves of its
// token and domains don't interleave; removing it holds it whole. Reading
// its zones needs no lock.
const connectionKey = (connectionId: string) =>
  `cloudflare-connection:${connectionId}`

/** The zones a pasted token, or a saved connection's, can manage. */
export async function discoverCloudflareDomainsHandler(
  data: DiscoverDomainsInput
) {
  const user = await requireEligibleResourceUser()
  const apiToken =
    data.apiToken ??
    (data.connectionId
      ? await savedApiToken(user, data.connectionId)
      : undefined)
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

/**
 * Saves a Cloudflare connection: its name, token, and which of its zones'
 * domains are vanity domains. A person's own, or the platform's for an
 * administrator.
 */
// What a save needs once the person may make it and Cloudflare answered:
// read and checked before the connection is held.
async function prepareConnectionSave(
  user: AuthenticatedUser,
  data: SaveDomainConnectionInput
) {
  const existing = data.id
    ? await runAppEffect(
        "domains.connection.load",
        loadDomainConnectionEffect(data.id)
      )
    : null
  if (
    data.id &&
    (!existing || !canManageConnection(user, existing.connection))
  ) {
    throw new Error("That Cloudflare connection was removed")
  }
  const ownerId = existing
    ? existing.connection.ownerId
    : data.platform
      ? null
      : user.id
  if (ownerId === null && !isPlatformAdmin(user)) {
    throw new Error("Platform administrator access required")
  }
  const requested = [
    ...new Map(data.domains.map((item) => [item.domain, item])).values(),
  ]
  if (
    data.defaultDomain &&
    !requested.some((item) => item.domain === data.defaultDomain)
  ) {
    throw new Error("Choose a default domain from the list")
  }
  // The dialog lists one domain per zone, so its choices can't collapse.
  const zoneIds = new Set(requested.map((item) => item.zoneId))
  if (zoneIds.size !== requested.length) {
    throw new Error("Choose one domain per Cloudflare zone")
  }
  const apiToken =
    data.apiToken ?? (data.id ? await savedApiToken(user, data.id) : undefined)
  if (!apiToken) throw new Error("Enter a Cloudflare API token")
  const zones = await runAppEffect(
    "cloudflare.zones.list",
    listCloudflareZonesEffect(apiToken)
  )
  const zonesById = new Map(zones.map((zone) => [zone.id, zone]))
  const domains = requested.map(
    (item): Omit<ManagedDomain, "connectionId" | "ownerId"> => {
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
    }
  )
  const id = existing?.connection.id ?? randomUUID().replaceAll("-", "")
  // Domains left out that still have game server domains stay, disabled;
  // the save decides which under its locks.
  const blacklistPatterns = validateBlacklistPatterns(
    data.blacklistPatterns ?? existing?.connection.blacklistPatterns ?? []
  )
  requireFastReservedPatterns(blacklistPatterns)
  return { domains, existing, id, ownerId, zones, blacklistPatterns }
}

const saveConnection = operation<SaveDomainConnectionInput>()({
  name: "dns.connection.save",
  doing: "Saving this Cloudflare connection",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        promiseEffect(() => prepareConnectionSave(person, input))
      )
    ),
  locks: ({ context }) => [
    exclusive(partKey(connectionKey(context.id), "settings")),
  ],
  run: ({ context, input }) =>
    saveDomainConnectionEffect({
      apiToken: input.apiToken,
      blacklistPatterns: context.blacklistPatterns,
      domains: context.domains,
      id: context.id,
      insert: !context.existing,
      name: input.name,
      ownerId: context.ownerId,
      zones: context.zones,
    }).pipe(
      Effect.andThen(invalidateManagedDomainAddressesEffect),
      Effect.as({ id: context.id })
    ),
  audit: ({ context }) => ({ id: context.id, kind: "cloudflare-connection" }),
  publish: ({ exit }) => {
    if (exit._tag === "Success") publishDomainChange()
  },
})

export async function saveDomainConnectionHandler(
  data: SaveDomainConnectionInput
) {
  const user = await requireEligibleResourceUser()
  return runOperationPromise(saveConnection, data, { user })
}

/**
 * Removes a connection. Refused while game server domains use its vanity
 * domains, or web routes or app addresses use it: their names stay theirs
 * until they're removed.
 */
const deleteConnection = operation<DeleteDomainConnectionInput>()({
  name: "dns.connection.delete",
  doing: "Removing this Cloudflare connection",
  authorize: ({ input, user }) =>
    Effect.gen(function* () {
      const person = yield* signedIn(user)
      const existing = yield* loadDomainConnectionEffect(input.id)
      return (
        existing !== null && canManageConnection(person, existing.connection)
      )
    }),
  locks: ({ context: allowed, input }) =>
    allowed ? [exclusive(connectionKey(input.id))] : [],
  run: ({ context: allowed, input }) =>
    allowed
      ? requireConnectionUnusedEffect(input.id).pipe(
          Effect.andThen(deleteDomainConnectionEffect(input.id)),
          Effect.andThen(invalidateManagedDomainAddressesEffect)
        )
      : Effect.void,
  audit: ({ context: allowed, input }) =>
    allowed ? { id: input.id, kind: "cloudflare-connection" } : null,
  publish: ({ context: allowed, exit }) => {
    if (allowed && exit._tag === "Success") publishDomainChange()
  },
})

export async function deleteDomainConnectionHandler(
  data: DeleteDomainConnectionInput
) {
  const user = await requireEligibleResourceUser()
  await runOperationPromise(deleteConnection, data, { user })
}

/**
 * Brings game server domains in line with their servers and web hostnames
 * with their Relays, retrying failed ones: every one for administrators,
 * otherwise those on what the person can change.
 */
// The person's request, for its trace and audit. It spans every game server
// they can change, so it holds none itself: each server's domains and web
// hostnames change in their own `#dns`, as they do whenever they're synced.
const resyncDomains = operation<void>()({
  name: "domains.resync",
  doing: "Syncing domains",
  authorize: ({ user }) => signedIn(user),
  locks: () => [],
  run: ({ context: person }) =>
    promiseEffect(() => outsideOperation(() => resyncDomainsFor(person))),
})

export async function resyncDomainAssignmentsHandler() {
  return runOperationPromise(resyncDomains, undefined, {
    user: await requireEligibleResourceUser(),
  })
}

async function resyncDomainsFor(user: AuthenticatedUser) {
  const access = await resourceAccess(user)
  const relays = (await listPersistedRelays()).filter((relay) => relay.enabled)
  // A Relay that can't be reached skips its game servers, not the rest.
  const snapshots = await Promise.all(
    relays.map((relay) =>
      recoverPromise(
        async () => ({
          relay,
          snapshot: relaySnapshotSchema.parse(
            await runAppEffect(
              "relay.snapshot.domains.resync",
              relayJsonEffect(relay, "/v1/snapshot", (input) => input)
            )
          ),
        }),
        () => ({ relay, snapshot: null })
      )
    )
  )
  const unreachable = snapshots.filter(({ snapshot }) => !snapshot)
  const instances = snapshots.flatMap(({ relay, snapshot }) =>
    (snapshot?.instances ?? [])
      .filter((instance) => access.instance(relay.id, instance.id, true))
      .map((instance) => ({ ...instance, relayId: relay.id }))
  )
  const { serverFailures: failures, ...hostnames } = await runAppEffect(
    "domains.resync",
    resyncAddressesEffect(instances, (row) =>
      row.resourceType === "app"
        ? access.app(row.relayId, row.resourceId, true)
        : access.instance(row.relayId, row.resourceId, true)
    )
  )
  // Ones still waiting on work, as deletes left by a removed Relay, are
  // retried now rather than after their wait.
  await runAppEffect("domains.retryNow", retryAddressesNowEffect())
  wakePollingWorker("Domains.dns")
  publishDomainChange()
  if (failures.length > 0) {
    const reason = failures[0]
    throw new Error(
      `Could not sync ${failures.length} of ${instances.length} server addresses: ${
        reason instanceof Error ? reason.message : "Cloudflare sync failed"
      }`
    )
  }
  if (hostnames.failure) {
    throw new Error(`Could not sync every web hostname: ${hostnames.failure}`)
  }
  const [offline] = unreachable
  if (offline) {
    throw new Error(
      unreachable.length === 1
        ? `Synced everything except ${offline.relay.name}'s game servers, which Kiln couldn't reach`
        : `Synced everything except the game servers on ${unreachable.length} Relays Kiln couldn't reach`
    )
  }
  return {
    syncedHostnameCount: hostnames.checked,
    syncedServerCount: instances.length,
  }
}

async function savedApiToken(
  user: AuthenticatedUser,
  connectionId: string
): Promise<string | undefined> {
  const credential = await runAppEffect(
    "domains.connection.credential",
    loadDomainConnectionCredentialEffect(connectionId).pipe(
      Effect.orElseSucceed(() => null)
    )
  )
  return credential && canManageConnection(user, credential)
    ? credential.apiToken
    : undefined
}

function serverKey(relayId: string, id: string): string {
  return `${relayId}:${id}`
}

// Domains managed elsewhere: Kiln holds the names under one and writes no
// records. Each is its own lane, so adding and removing one never
// interleave.
const manualDomainKey = (domain: string) => `domain:${domain}`

export const manualDomainInputSchema = z.strictObject({
  domain: domainNameSchema,
  // Kiln's, which administrators manage and anyone may use under their
  // rules; otherwise the person's own.
  platform: z.boolean().optional(),
})

type ManualDomainInput = z.infer<typeof manualDomainInputSchema>

const addManualDomain = operation<ManualDomainInput>()({
  name: "domain.manual.add",
  doing: "Adding this domain",
  authorize: ({ input, user }) =>
    signedIn(user).pipe(
      Effect.flatMap((person) =>
        input.platform && !isPlatformAdmin(person)
          ? Effect.fail(
              new Error("Only an administrator can add one of Kiln's domains")
            )
          : Effect.succeed(input.platform ? null : person.id)
      )
    ),
  locks: ({ input }) => [exclusive(manualDomainKey(input.domain))],
  run: ({ context: ownerId, input }) =>
    addManualDomainEffect(input.domain, ownerId).pipe(
      Effect.andThen(
        promiseEffect(async () => {
          // What its Relays already route under it is now held for the
          // instances that route it.
          const routes = (await readRelayRoutes(await listPersistedRelays()))
            .filter((route) =>
              domainInZone(route.hostname.toLowerCase(), input.domain)
            )
            .flatMap((route): Array<RoutedHostname> =>
              route.owner.kind === "app" || route.owner.kind === "instance"
                ? [
                    {
                      hostname: route.hostname.toLowerCase(),
                      resource: {
                        relayId: route.relayId,
                        resourceId: route.owner.id,
                        resourceType: route.owner.kind,
                      },
                    },
                  ]
                : []
            )
          return runAppEffect(
            "addresses.attachManual",
            attachManualHostnamesEffect(input.domain, routes)
          )
        })
      )
    ),
  audit: ({ input }) => ({ id: input.domain, kind: "domain" }),
  publish: ({ exit }) => {
    if (exit._tag === "Success") publishDomainChange()
  },
})

export async function addManualDomainHandler(data: ManualDomainInput) {
  const user = await requireEligibleResourceUser()
  return runOperationPromise(addManualDomain, data, { user })
}

export const removeManualDomainInputSchema = z.strictObject({
  domain: domainNameSchema,
})

const removeManualDomain = operation<{ domain: string }>()({
  name: "domain.manual.remove",
  doing: "Removing this domain",
  authorize: ({ input, user }) =>
    Effect.gen(function* () {
      const person = yield* signedIn(user)
      const [domain] = (yield* listManualDomainsEffect("all")).filter(
        (candidate) => candidate.domain === input.domain
      )
      return (
        domain !== undefined &&
        (domain.ownerId === null
          ? isPlatformAdmin(person)
          : domain.ownerId === person.id || isPlatformAdmin(person))
      )
    }),
  locks: ({ context: allowed, input }) =>
    allowed ? [exclusive(manualDomainKey(input.domain))] : [],
  run: ({ context: allowed, input }) =>
    allowed ? removeManualDomainEffect(input.domain) : Effect.void,
  audit: ({ context: allowed, input }) =>
    allowed ? { id: input.domain, kind: "domain" } : null,
  publish: ({ context: allowed, exit }) => {
    if (allowed && exit._tag === "Success") publishDomainChange()
  },
})

export async function removeManualDomainHandler(data: { domain: string }) {
  const user = await requireEligibleResourceUser()
  await runOperationPromise(removeManualDomain, data, { user })
}
