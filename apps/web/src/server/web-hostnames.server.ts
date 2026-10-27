import { randomUUID } from "node:crypto"

import { Clock, Effect, Semaphore } from "effect"

import {
  cloudflareAddressRecord,
  cloudflareHostnameAvailableEffect,
  createCloudflareWebRecordEffect,
  deleteCloudflareRecordEffect,
  listCloudflareZonesEffect,
  replaceCloudflareWebRecordEffect,
  updateCloudflareWebRecordEffect,
} from "@/effect/cloudflare-api"
import {
  listDomainConnectionsEffect,
  loadDomainConnectionCredentialEffect,
  loadManagedDomainEffect,
  loadUsedVanityLabelsEffect,
  updateDomainConnectionZonesEffect,
  type DomainConnection,
} from "@/effect/domains"
import { DomainConfigurationError, HostnameInUseError } from "@/effect/errors"
import {
  activateWebHostnameEffect,
  clearWebHostnameRecordEffect,
  deleteWebHostnameEffect,
  insertWebHostnameEffect,
  listResourceWebHostnamesEffect,
  listWebHostnamesEffect,
  loadHostnameHolderEffect,
  loadWebHostnameEffect,
  reassignWebHostnamesEffect,
  setWebHostnameStatusEffect,
  type WebHostname,
  type WebHostnameResource,
} from "@/effect/web-hostnames"
import { promiseEffect } from "@/effect/promise"
import { domainInZone } from "@/lib/domain-schemas"
import { vanityLabelAllowed } from "@/server/reserved-names"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionSnapshot } from "@/lib/relay-connection"
import { activeRelay } from "@/lib/relay-registry"
import {
  chooseVanityDomainEffect,
  loadResourceOwnerIdEffect,
  ownsVanityDomain,
  vanityDomainUsable,
  type DomainActor,
} from "@/server/domain-access.server"
import { generateVanityCandidates } from "@/server/vanity-names"

/** Where Kiln may create a hostname's record. */
interface HostnameZone {
  connectionId: string
  /** The vanity domain it's a name under, when it is one. */
  vanityDomain: string | null
  zoneId: string
}

// Syncing a resource's hostnames reads its rows and then changes Cloudflare
// records. One permit per resource keeps two saves of its routes from
// creating a record twice. Hearth runs one application process.
const resourceLocks = new Map<string, Semaphore.Semaphore>()

function withResourceLock<A, E, R>(
  resource: WebHostnameResource,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> {
  const key = `${resource.relayId}:${resource.resourceType}:${resource.resourceId}`
  let lock = resourceLocks.get(key)
  if (!lock) {
    lock = Semaphore.makeUnsafe(1)
    resourceLocks.set(key, lock)
  }
  return lock.withPermit(effect)
}

// A token's zones are remembered when it's saved. A hostname in none of them
// lists them again, at most this often per connection, in case a zone was
// added to the token since.
const zoneRefreshIntervalMs = 60_000

/**
 * The public address a Relay's web routes are served at, as it reports it,
 * or its game servers' address, or the address Hearth reaches it at.
 */
export const relayPublicHostEffect = Effect.fn("webHostnames.relayHost")(
  function* (relayId: string) {
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
  }
)

/**
 * The connection and zone Kiln may make `hostname`'s record in for a resource
 * owned by `ownerId`, or null if none. A single name under a vanity domain
 * the resource may use goes there; anything else needs a zone on the
 * person's own connections, its owner's when they are the owner, or the
 * platform's when they're an administrator.
 */
export const resolveHostnameZoneEffect = Effect.fn("webHostnames.resolve")(
  function* (hostname: string, ownerId: string | null, actor: DomainActor) {
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
  }
)

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

/**
 * Brings a game server's or app's hostnames in line with its web routes:
 * records for hostnames it no longer routes go, ones the person may manage
 * are made, and the rest point at the Relay. Kiln's generated app address
 * stays without a route. Each hostname stands alone, so one failing leaves
 * the others; failures show on its row. With no `actor`, only hostnames
 * Kiln already keeps are synced.
 */
export const syncResourceWebHostnamesEffect = Effect.fn("webHostnames.sync")(
  function* (input: {
    actor: DomainActor | null
    hostnames: ReadonlyArray<string>
    resource: WebHostnameResource
  }) {
    const { actor, resource } = input
    const existing = yield* listResourceWebHostnamesEffect(resource)
    const wanted = new Set(input.hostnames.map((name) => name.toLowerCase()))
    const kept: Array<WebHostname> = []
    for (const row of existing) {
      if (wanted.has(row.hostname) || row.generated) kept.push(row)
      else yield* removeWebHostnameEffect(row).pipe(Effect.ignore)
    }
    const target = yield* relayPublicHostEffect(resource.relayId)
    const held = new Map(existing.map((row) => [row.hostname, row]))
    const added: Array<WebHostname> = []
    if (actor) {
      const fresh = freshHostnames([...wanted], held)
      const ownerId =
        fresh.length > 0 ? yield* loadResourceOwnerIdEffect(resource) : null
      for (const hostname of fresh) {
        // Saves claim their names first; one that couldn't is left alone.
        const row = yield* claimHostnameEffect(
          resource,
          hostname,
          ownerId,
          actor,
          held
        ).pipe(Effect.orElseSucceed(() => null))
        if (row) {
          added.push(row)
          held.set(row.hostname, row)
        }
      }
    }
    for (const row of [...kept, ...added]) {
      yield* reconcileWebHostnameEffect(row, target).pipe(Effect.ignore)
    }
    return added.length > 0 || kept.length !== existing.length
  },
  (effect, input) => withResourceLock(input.resource, effect)
)

/**
 * Claims the hostnames a resource's web routes are about to use, before they
 * save, so two saves can't both take one. Refuses, without claiming any:
 * one another game server or app holds, and, under a vanity domain someone
 * else owns (such as one Kiln provides), a reserved name or one Cloudflare
 * already has a record for. Names the resource holds, its game server
 * addresses included, pass. Returns the rows it claimed, to release if the
 * save fails.
 */
export const claimWebRouteHostnamesEffect = Effect.fn("webHostnames.claim")(
  function* (input: {
    actor: DomainActor
    hostnames: ReadonlyArray<string>
    resource: WebHostnameResource
  }) {
    const { actor, resource } = input
    const held = new Map(
      (yield* listResourceWebHostnamesEffect(resource)).map((row) => [
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
        if (sameResource(holder, resource)) continue
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
    const claimed: Array<WebHostname> = []
    for (const hostname of fresh) {
      const row = yield* claimHostnameEffect(
        resource,
        hostname,
        ownerId,
        actor,
        held
      ).pipe(Effect.tapError(() => releaseWebHostnameClaimsEffect(claimed)))
      if (row) {
        claimed.push(row)
        held.set(row.hostname, row)
      }
    }
    return claimed
  },
  (effect, input) => withResourceLock(input.resource, effect)
)

/** Forgets claims whose routes never saved; none has a record yet. */
export const releaseWebHostnameClaimsEffect = Effect.fn(
  "webHostnames.releaseClaims"
)(function* (rows: ReadonlyArray<WebHostname>) {
  for (const row of rows) yield* deleteWebHostnameEffect(row.id)
})

/**
 * Hostnames not yet held, lowercased, each once, names before their `www`
 * counterparts so a counterpart can follow its name.
 */
function freshHostnames(
  hostnames: ReadonlyArray<string>,
  held: ReadonlyMap<string, WebHostname>
): Array<string> {
  return [...new Set(hostnames.map((name) => name.toLowerCase()))]
    .filter((name) => !held.has(name))
    .sort(
      (left, right) =>
        Number(left.startsWith("www.")) - Number(right.startsWith("www."))
    )
}

function sameResource(
  left: WebHostnameResource,
  right: WebHostnameResource
): boolean {
  return (
    left.relayId === right.relayId &&
    left.resourceId === right.resourceId &&
    left.resourceType === right.resourceType
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
 * Holds a hostname for a resource, in the zone Kiln may make its record in,
 * or returns null when there's none or something already holds it. A `www`
 * counterpart of a vanity name the resource holds goes in that name's zone.
 */
const claimHostnameEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  hostname: string,
  ownerId: string | null,
  actor: DomainActor,
  held: ReadonlyMap<string, WebHostname>
) {
  // Another resource's, or this game server's own address, which has DNS.
  if (yield* loadHostnameHolderEffect(hostname)) return null
  const base = hostname.startsWith("www.")
    ? held.get(hostname.slice(4))
    : undefined
  const zone: HostnameZone | null = base?.vanityDomain
    ? {
        connectionId: base.connectionId,
        vanityDomain: null,
        zoneId: base.zoneId,
      }
    : yield* resolveHostnameZoneEffect(hostname, ownerId, actor)
  if (!zone) return null
  const id = randomUUID()
  yield* insertWebHostnameEffect({
    ...resource,
    connectionId: zone.connectionId,
    generated: false,
    hostname,
    id,
    vanityDomain: zone.vanityDomain,
    zoneId: zone.zoneId,
  }).pipe(
    Effect.catchTag("DomainConfigurationError", () =>
      loadHostnameHolderEffect(hostname).pipe(
        Effect.flatMap((holder) =>
          HostnameInUseError.make({
            holder,
            hostname,
            message: `${hostname} is already in use`,
          })
        )
      )
    )
  )
  return yield* loadWebHostnameEffect(id)
})

/**
 * Gives a new app an address under a vanity domain it may use, as game
 * servers get one, and points it at its Relay. Null when no vanity domain
 * applies.
 */
export const generateAppHostnameEffect = Effect.fn("webHostnames.generate")(
  function* (resource: WebHostnameResource) {
    const ownerId = yield* loadResourceOwnerIdEffect(resource)
    const domain = yield* chooseVanityDomainEffect(ownerId)
    if (!domain) return null
    const [{ apiToken, blacklistPatterns }, used, target] = yield* Effect.all(
      [
        loadDomainConnectionCredentialEffect(domain.connectionId),
        loadUsedVanityLabelsEffect(domain.domain),
        relayPublicHostEffect(resource.relayId),
      ],
      { concurrency: 3 }
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
        generated: true,
        hostname,
        id,
        vanityDomain: domain.domain,
        zoneId: domain.zoneId,
      }).pipe(
        Effect.as(true),
        Effect.catchTag("DomainConfigurationError", () => Effect.succeed(false))
      )
      if (!reserved) continue
      const row = yield* loadWebHostnameEffect(id)
      if (row) yield* reconcileWebHostnameEffect(row, target)
      return hostname
    }
    return yield* DomainConfigurationError.make({
      message: "Kiln could not find an available address",
    })
  },
  (effect, resource) => withResourceLock(resource, effect)
)

/**
 * Points a hostname's record at `target`, making it when there's none. A
 * name Cloudflare already has a record for, that Kiln didn't make, is left
 * alone and marked `external`.
 */
const reconcileWebHostnameEffect = Effect.fn("webHostnames.reconcile")(
  function* (row: WebHostname, target: string) {
    if (row.status === "removing") {
      return yield* removeWebHostnameEffect(row)
    }
    const record = cloudflareAddressRecord(row.hostname, target)
    if (
      row.status === "active" &&
      row.recordId &&
      row.target === target &&
      row.recordType === record.type
    ) {
      return
    }
    const comment = `Managed by Kiln for ${
      row.resourceType === "app" ? "app" : "server"
    } ${row.resourceId}`
    const sync = Effect.gen(function* () {
      const { apiToken } = yield* loadDomainConnectionCredentialEffect(
        row.connectionId
      )
      if (row.recordId) {
        const recordId = row.recordId
        const updated = yield* row.recordType === record.type
          ? updateCloudflareWebRecordEffect(
              apiToken,
              row.zoneId,
              recordId,
              record,
              comment
            )
          : replaceCloudflareWebRecordEffect(
              apiToken,
              row.zoneId,
              recordId,
              record,
              comment
            )
        // Deleted in Cloudflare meanwhile: make it again below. Any other
        // failure keeps the record Kiln made, to retry.
        if (!updated) yield* clearWebHostnameRecordEffect(row.id)
        else {
          return yield* activateWebHostnameEffect({
            id: row.id,
            recordId: updated.id,
            recordType: record.type,
            target,
          })
        }
      }
      const available = yield* cloudflareHostnameAvailableEffect(
        apiToken,
        row.zoneId,
        row.hostname
      )
      if (!available) {
        return yield* setWebHostnameStatusEffect(
          row.id,
          "external",
          `Cloudflare already has a record for ${row.hostname}. Kiln leaves records it didn't create alone.`
        )
      }
      const created = yield* createCloudflareWebRecordEffect(
        apiToken,
        row.zoneId,
        record,
        comment
      )
      yield* activateWebHostnameEffect({
        id: row.id,
        recordId: created.id,
        recordType: record.type,
        target,
      })
    })
    yield* sync.pipe(
      Effect.tapError((error) =>
        setWebHostnameStatusEffect(row.id, "error", error.message).pipe(
          Effect.ignore
        )
      )
    )
  }
)

/**
 * Deletes a hostname's record and forgets it. One Cloudflare refuses stays
 * `removing`, with why, until a sync finishes it.
 */
const removeWebHostnameEffect = Effect.fn("webHostnames.remove")(function* (
  row: WebHostname
) {
  if (!row.recordId) return yield* deleteWebHostnameEffect(row.id)
  const recordId = row.recordId
  yield* setWebHostnameStatusEffect(row.id, "removing", null)
  yield* loadDomainConnectionCredentialEffect(row.connectionId).pipe(
    Effect.flatMap(({ apiToken }) =>
      deleteCloudflareRecordEffect(apiToken, row.zoneId, recordId)
    ),
    Effect.andThen(deleteWebHostnameEffect(row.id)),
    Effect.tapError((error) =>
      setWebHostnameStatusEffect(
        row.id,
        "removing",
        `Delete failed: ${error.message}`
      ).pipe(Effect.ignore)
    )
  )
})

/** Releases one hostname, such as an app's generated address. */
export const releaseWebHostnameEffect = Effect.fn("webHostnames.release")(
  function* (row: WebHostname) {
    yield* removeWebHostnameEffect(row)
  },
  (effect, row) => withResourceLock(row, effect)
)

/** Deletes every record a deleted game server or app had. */
export const deleteResourceWebHostnamesEffect = Effect.fn(
  "webHostnames.deleteResource"
)(
  function* (resource: WebHostnameResource) {
    const rows = yield* listResourceWebHostnamesEffect(resource)
    for (const row of rows) yield* removeWebHostnameEffect(row)
    return rows.length
  },
  (effect, resource) => withResourceLock(resource, effect)
)

/**
 * Hands a game server's hostnames to the one that takes its place, as moving
 * it to another Relay does, and points them at the new Relay.
 */
export const moveResourceWebHostnamesEffect = Effect.fn("webHostnames.move")(
  function* (from: WebHostnameResource, to: WebHostnameResource) {
    const moved = yield* reassignWebHostnamesEffect(from, to)
    const rows = yield* listResourceWebHostnamesEffect(to)
    if (rows.length > 0) {
      const target = yield* relayPublicHostEffect(to.relayId)
      for (const row of rows) {
        yield* reconcileWebHostnameEffect(row, target).pipe(Effect.ignore)
      }
    }
    publishWebHostnameChange([from.relayId, to.relayId])
    return moved
  },
  (effect, from, to) => withResourceLock(from, withResourceLock(to, effect))
)

/**
 * Forgets a removed Relay's hostnames, deleting their records first when
 * asked. Reports how many it had.
 */
export const removeRelayWebHostnamesEffect = Effect.fn(
  "webHostnames.removeRelay"
)(function* (relayId: string, removeRecords: boolean) {
  const rows = yield* listWebHostnamesEffect({ relayId })
  for (const row of rows) {
    yield* (
      removeRecords
        ? removeWebHostnameEffect(row)
        : deleteWebHostnameEffect(row.id)
    ).pipe(Effect.ignore)
  }
  return rows.length
})

/**
 * Deletes the records a connection made, before it goes. Fails if any
 * can't be deleted, so its token isn't forgotten while records remain.
 */
export const removeConnectionWebHostnamesEffect = Effect.fn(
  "webHostnames.removeConnection"
)(function* (connectionId: string) {
  const rows = yield* listWebHostnamesEffect({ connectionId })
  for (const row of rows) yield* removeWebHostnameEffect(row)
})

/**
 * Points hostnames at their Relays again and retries failed ones. Reports
 * how many it checked and the first failure's message.
 */
export const resyncWebHostnamesEffect = Effect.fn("webHostnames.resync")(
  function* (include: (row: WebHostname) => boolean) {
    const rows = (yield* listWebHostnamesEffect()).filter(include)
    const targets = new Map<string, string>()
    let failure: string | null = null
    for (const row of rows) {
      const outcome = yield* Effect.gen(function* () {
        let target = targets.get(row.relayId)
        if (target === undefined) {
          target = yield* relayPublicHostEffect(row.relayId)
          targets.set(row.relayId, target)
        }
        const relayTarget = target
        return yield* withResourceLock(
          row,
          Effect.gen(function* () {
            // Read again under the lock: a save or delete may have released
            // or moved it since the list was read.
            const current = yield* loadWebHostnameEffect(row.id)
            if (!current || !sameResource(current, row)) return null
            yield* reconcileWebHostnameEffect(current, relayTarget)
            const after = yield* loadWebHostnameEffect(row.id)
            return after?.status === "error" ? after.lastError : null
          })
        )
      }).pipe(Effect.catch((error) => Effect.succeed(error.message)))
      failure ??= outcome
    }
    return { checked: rows.length, failure }
  }
)

export function publishWebHostnameChange(relayIds: ReadonlyArray<string>) {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [...new Set(relayIds)] },
    topics: ["domains"],
    type: "hearth.invalidate",
  })
}
