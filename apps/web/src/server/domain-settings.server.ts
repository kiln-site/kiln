import { randomUUID } from "node:crypto"

import {
  builtinTailscaleBrickId,
  relayProxyConfigurationSchema,
  relayProxyConfigurationV1Feature,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect } from "effect"

import { listCloudflareZonesEffect } from "@/effect/cloudflare-api"
import {
  deleteDomainConnectionEffect,
  listDomainConnectionsEffect,
  listUsableVanityDomainsEffect,
  loadDomainConnectionCredentialEffect,
  loadDomainConnectionEffect,
  loadInstanceDomainAssignmentsEffect,
  requireConnectionUnusedEffect,
  saveDomainConnectionEffect,
  type DomainConnection,
  type ManagedDomain,
  retryInstanceDomainsNowEffect,
} from "@/effect/domains"
import { wakePollingWorker } from "@/lib/polling-worker"
import { listAppRecordsEffect } from "@/effect/managed-apps"
import { recoverPromise } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { listWebHostnamesEffect } from "@/effect/web-hostnames"
import { isPlatformAdmin } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  domainHasActiveSrvRecord,
  managedDomainConnectAddress,
} from "@/lib/domain-address"
import { publishDomainChange } from "@/lib/domain-realtime.server"
import { domainInZone, validateBlacklistPatterns } from "@/lib/domain-schemas"
import { kilnRootDomain } from "@/lib/environment"
import { listInstanceDirectoryEffect } from "@/lib/instance-directory"
import { relayInstanceRouteId } from "@/lib/relay-fleet"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import { activeRelay, listPersistedRelays } from "@/lib/relay-registry"
import { relayJsonEffect } from "@/lib/relay-client"
import { shortIdRouteIdentifier } from "@/lib/short-id-route"
import { requireEligibleResourceUser } from "@/server/auth"
import { resourceAccess } from "@/server/domain-resource-access.server"
import { serialized } from "@/operations/serialized"
import { requireFastReservedPatterns } from "@/server/reserved-names"
import {
  invalidateManagedDomainAddressesEffect,
  provisionInstanceDomainEffect,
} from "@/server/domains.server"
import { resyncWebHostnamesEffect } from "@/server/web-hostnames.server"
import type {
  DeleteDomainConnectionInput,
  DiscoverDomainsInput,
  ManagedDomainOverview,
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
    runAppEffect(
      "domains.assignments.all",
      loadInstanceDomainAssignmentsEffect()
    ),
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
    access.instance(assignment.relayId, assignment.instanceId, false)
  )
  const domainCounts = new Map<string, number>()
  for (const assignment of visibleAssignments) {
    const key = serverKey(assignment.relayId, assignment.instanceId)
    domainCounts.set(key, (domainCounts.get(key) ?? 0) + 1)
  }
  const managedDomains = visibleAssignments.map(
    (assignment): ManagedDomainOverview => {
      const key = serverKey(assignment.relayId, assignment.instanceId)
      const server = resources.server(assignment.relayId, assignment.instanceId)
      return {
        address: managedDomainConnectAddress(assignment),
        canManage: access.instance(
          assignment.relayId,
          assignment.instanceId,
          true
        ),
        domain: assignment.domain,
        domainCount: domainCounts.get(key) ?? 1,
        id: assignment.id,
        instanceId: assignment.instanceId,
        lastError: assignment.lastError,
        port: assignment.publicPort,
        primary: assignment.primary,
        relayId: assignment.relayId,
        relayName: resources.relayName(assignment.relayId),
        server: {
          brickId: server?.brickId,
          game: server?.game,
          implementation: server?.implementation,
          name: server?.name ?? assignment.instanceId.slice(0, 8),
          routeId: resources.serverRoute(
            assignment.relayId,
            assignment.instanceId
          ),
        },
        srvActive: domainHasActiveSrvRecord(assignment),
        status: assignment.status,
        supportsSrv: assignment.supportsSrv,
        vanityLabel: assignment.vanityLabel,
        zoneName: zoneNames.get(assignment.domain) ?? null,
      }
    }
  )

  const webHostnames = hostnames.flatMap((row): Array<WebHostnameOverview> => {
    const isApp = row.resourceType === "app"
    const readable = isApp
      ? access.app(row.relayId, row.resourceId, false)
      : access.instance(row.relayId, row.resourceId, false)
    if (!readable) return []
    return [
      {
        canManage: isApp
          ? access.app(row.relayId, row.resourceId, true)
          : access.instance(row.relayId, row.resourceId, true),
        connectionName: connectionNames.get(row.connectionId) ?? null,
        generated: row.generated,
        hostname: row.hostname,
        id: row.id,
        lastError: row.lastError,
        relayId: row.relayId,
        routed: row.routed,
        relayName: resources.relayName(row.relayId),
        resource: resources.webResource(
          row.resourceType,
          row.relayId,
          row.resourceId
        ),
        status: row.status,
        target: row.target,
        vanity: row.vanityDomain !== null,
        zoneName:
          zoneNameFor(row.hostname, connections, row.connectionId) ??
          (row.vanityDomain ? (zoneNames.get(row.vanityDomain) ?? null) : null),
      },
    ]
  })

  const platformDomains = usable
    .filter((domain) => domain.ownerId === null && domain.enabled)
    .map((domain) => ({ domain: domain.domain, isDefault: domain.isDefault }))

  return {
    canManagePlatform: admin,
    connections: connections.map(publicConnection),
    hearthDomain: kilnRootDomain(),
    managedDomains,
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
          // An unreachable Relay's rows wait for the next refresh.
          () => []
        )
      )
  )
  const seen = new Set<string>()
  return perRelay.flat().flatMap((route): Array<WebHostnameOverview> => {
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
        connectionName: null,
        generated: false,
        hostname,
        id: key,
        lastError: null,
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
  // Match the Game Servers table: a short ID routes on its own unless another
  // game server shares it.
  const shortIdCounts = new Map<string, number>()
  for (const record of directory) {
    if (record.brickId === builtinTailscaleBrickId) continue
    const shortId = record.id.slice(0, 8)
    shortIdCounts.set(shortId, (shortIdCounts.get(shortId) ?? 0) + 1)
  }
  const appIds = apps.map((app) => ({ id: app.appId }))
  const appsByKey = new Map(
    apps.map((app) => [serverKey(app.relayId, app.appId), app])
  )
  const server = (relayId: string, instanceId: string) =>
    servers.get(serverKey(relayId, instanceId))
  const serverRoute = (relayId: string, instanceId: string) => {
    const shortId = instanceId.slice(0, 8)
    // Otherwise the Relay-qualified full ID, which names exactly one server
    // even where short IDs collide or the server is missing from the
    // directory.
    return server(relayId, instanceId) && shortIdCounts.get(shortId) === 1
      ? shortId
      : relayInstanceRouteId(relayId, instanceId)
  }
  return {
    relayName: (relayId: string) => relayNames.get(relayId) ?? "Unknown Relay",
    server,
    serverRoute,
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
          name: app?.name ?? resourceId.slice(0, 8),
          routeId: shortIdRouteIdentifier(appIds, { id: resourceId }),
        }
      }
      const record = server(relayId, resourceId)
      return {
        brickId: record?.brickId,
        id: resourceId,
        implementation: record?.implementation,
        kind: "server",
        name: record?.name ?? resourceId.slice(0, 8),
        routeId: serverRoute(relayId, resourceId),
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

// Saving or removing a Cloudflare connection holds it, so two changes to
// one connection, its token and domains, don't interleave. Reading its
// zones needs no lock.
const connectionKey = (connectionId: string) => `connection:${connectionId}`

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
export async function saveDomainConnectionHandler(
  data: SaveDomainConnectionInput
) {
  const user = await requireEligibleResourceUser()
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
  await runAppEffect(
    "domains.connection.save",
    serialized(
      "dns.connection.save",
      [connectionKey(id)],
      saveDomainConnectionEffect({
        apiToken: data.apiToken,
        blacklistPatterns,
        domains,
        id,
        insert: !existing,
        name: data.name,
        ownerId,
        zones,
      }).pipe(Effect.andThen(invalidateManagedDomainAddressesEffect))
    )
  )
  publishDomainChange()
  return { id }
}

/**
 * Removes a connection. Refused while game server domains use its vanity
 * domains, or web routes or app addresses use it: their names stay theirs
 * until they're removed.
 */
export async function deleteDomainConnectionHandler(
  data: DeleteDomainConnectionInput
) {
  const user = await requireEligibleResourceUser()
  const existing = await runAppEffect(
    "domains.connection.load",
    loadDomainConnectionEffect(data.id)
  )
  if (!existing || !canManageConnection(user, existing.connection)) return
  await runAppEffect(
    "domains.connection.delete",
    serialized(
      "dns.connection.delete",
      [connectionKey(data.id)],
      requireConnectionUnusedEffect(data.id).pipe(
        Effect.andThen(deleteDomainConnectionEffect(data.id)),
        Effect.andThen(invalidateManagedDomainAddressesEffect)
      )
    )
  )
  publishDomainChange()
}

/**
 * Brings game server domains in line with their servers and web hostnames
 * with their Relays, retrying failed ones: every one for administrators,
 * otherwise those on what the person can change.
 */
export async function resyncDomainAssignmentsHandler() {
  const user = await requireEligibleResourceUser()
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
  const [[, failures], hostnames] = await Promise.all([
    runAppEffect(
      "domains.instances.resync",
      Effect.partition(instances, provisionInstanceDomainEffect, {
        concurrency: 1,
      })
    ),
    runAppEffect(
      "webHostnames.resync",
      resyncWebHostnamesEffect((row) =>
        row.resourceType === "app"
          ? access.app(row.relayId, row.resourceId, true)
          : access.instance(row.relayId, row.resourceId, true)
      )
    ),
  ])
  // Domains still waiting on work, as deletes left by a removed Relay, are
  // retried now rather than after their wait.
  await runAppEffect("domains.retryNow", retryInstanceDomainsNowEffect())
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
