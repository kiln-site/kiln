import { randomUUID } from "node:crypto"

import { Clock, Effect } from "effect"

import {
  cloudflareAddressRecord,
  cloudflareHostnameAvailableEffect,
  createCloudflareWebRecordEffect,
  deleteCloudflareRecordEffect,
  listCloudflareRecordsEffect,
  listCloudflareZonesEffect,
  replaceCloudflareWebRecordEffect,
  updateCloudflareWebRecordEffect,
} from "@/effect/cloudflare-api"
import {
  listDomainConnectionsEffect,
  loadDomainConnectionCredentialEffect,
  loadManagedDomainEffect,
  updateDomainConnectionZonesEffect,
  type DomainConnection,
} from "@/effect/domains"
import { DomainConfigurationError, HostnameInUseError } from "@/effect/errors"
import {
  canonicalHostname,
  loadClaimedLabelsEffect,
  loadHostnameHolderEffect,
  sameOwner,
} from "@/effect/hostname-claims"
import {
  activateWebHostnameEffect,
  clearWebHostnameRecordEffect,
  deferWebHostnamesEffect,
  deleteRelayWebHostnamesEffect,
  deleteWebHostnameEffect,
  insertWebHostnameEffect,
  listDueWebHostnameResourcesEffect,
  listResourceWebHostnamesEffect,
  listWebHostnamesEffect,
  loadWebHostnameEffect,
  markRelayWebHostnamesRemovingEffect,
  markWebHostnameCoveredEffect,
  markWebHostnamesRemovingEffect,
  reassignWebHostnamesEffect,
  reviveWebHostnamesEffect,
  setWebHostnamesRoutedEffect,
  setWebHostnameStatusEffect,
  webHostnameCoveredEffect,
  type WebHostname,
  type WebHostnameResource,
} from "@/effect/web-hostnames"
import { promiseEffect } from "@/effect/promise"
import { domainInZone } from "@/lib/domain-schemas"
import { vanityLabelAllowed } from "@/server/reserved-names"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { relayConnectionSnapshot } from "@/lib/relay-connection"
import { withResourceLock } from "@/lib/resource-locks"
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
 * Brings a game server's or app's DNS records in line with what Kiln holds
 * for it: records of hostnames marked for removal are deleted, and the rest
 * are made, or pointed at its Relay. It reads the hostnames afresh under
 * the resource's lock, so a run that starts late still does what the latest
 * save asked. Each hostname stands alone, so one failing leaves the others;
 * failures show on its row, and the DNS worker retries them. `verify` asks
 * Cloudflare about ones that look in step, as Sync does. Reports whether any
 * needed work.
 */
export const reconcileResourceWebHostnamesEffect = Effect.fn(
  "webHostnames.reconcileResource"
)(
  function* (resource: WebHostnameResource, verify = false) {
    const rows = yield* listResourceWebHostnamesEffect(resource)
    let changed = false
    for (const row of rows.filter((row) => row.status === "removing")) {
      changed = true
      yield* removeWebHostnameEffect(row).pipe(Effect.ignore)
    }
    const kept = rows.filter((row) => row.status !== "removing")
    if (kept.length === 0) return changed
    const target = yield* relayPublicHostEffect(resource.relayId).pipe(
      // Shown on the ones waiting for a record, until the Relay reports in.
      Effect.tapError((error) =>
        Effect.forEach(
          kept.filter((row) => row.status !== "active"),
          (row) => setWebHostnameStatusEffect(row.id, "error", error.message),
          { discard: true }
        )
      )
    )
    for (const row of kept) {
      const worked = yield* reconcileWebHostnameEffect(
        row,
        target,
        verify
      ).pipe(Effect.orElseSucceed(() => true))
      changed ||= worked
    }
    return changed
  },
  (effect, resource) => withResourceLock(resource, effect)
)

/**
 * Works through game servers' and apps' due DNS work: records to make or
 * delete, and ones that failed, once their retry is due. Hostnames that
 * still need work wait twice as long each time, up to an hour. Reports how
 * many resources it worked on.
 */
export const reconcileDueWebHostnamesEffect = Effect.fn(
  "webHostnames.reconcileDue"
)(function* (now: number) {
  const due = yield* listDueWebHostnameResourcesEffect(now)
  for (const resource of due) {
    yield* reconcileResourceWebHostnamesEffect(resource).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning(
          `DNS work for ${resource.resourceType} ${resource.resourceId} failed`,
          cause
        )
      )
    )
    yield* deferWebHostnamesEffect(resource, now)
  }
  if (due.length > 0) {
    publishWebHostnameChange(due.map((resource) => resource.relayId))
  }
  return due.length
})

/**
 * Claims the hostnames a resource's web routes are about to use, before they
 * save, so two saves can't both take one. Refuses, without claiming any:
 * one another game server or app holds, and, under a vanity domain someone
 * else owns (such as one Kiln provides), a reserved name or one Cloudflare
 * already has a record for. Names the resource holds, its game server
 * addresses included, pass. Returns the rows it claimed, to release if the
 * save fails.
 */
const claimHostnamesEffect = Effect.fn("webHostnames.claim")(function* (
  input: ClaimInput
) {
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
})

interface ClaimInput {
  actor: DomainActor
  hostnames: ReadonlyArray<string>
  resource: WebHostnameResource
}

/**
 * Saves a resource's web routes with `save`, the write that changes them,
 * holding the resource's lock throughout. Claims the hostnames they newly
 * use first, so nothing else takes one before the save settles. Once it
 * saves, hostnames the routes no longer use are marked for removal, keeping
 * their names until their records are gone. Their DNS records follow in
 * `reconcileResourceWebHostnamesEffect`.
 */
export function saveWebRouteHostnamesEffect<A, E, R>(
  input: ClaimInput,
  save: Effect.Effect<A, E, R>
) {
  return withResourceLock(
    input.resource,
    Effect.gen(function* () {
      // A failed save keeps its claims: the Relay may have taken the
      // routes even so. They get no record until a save says the routes
      // use them, and the next save that doesn't lets them go.
      yield* claimHostnamesEffect(input)
      const saved = yield* save
      const wanted = new Set(input.hostnames.map(canonicalHostname))
      const rows = yield* listResourceWebHostnamesEffect(input.resource)
      yield* reviveWebHostnamesEffect(
        rows
          .filter(
            (row) => row.status === "removing" && wanted.has(row.hostname)
          )
          .map((row) => row.id)
      )
      yield* markWebHostnamesRemovingEffect(
        rows
          .filter(
            (row) =>
              !row.generated &&
              row.status !== "removing" &&
              !wanted.has(row.hostname)
          )
          .map((row) => row.id)
      )
      // So an app's generated address isn't deleted while a route uses it.
      yield* setWebHostnamesRoutedEffect(input.resource, [...wanted])
      return saved
    })
  )
}

/**
 * Lets go of claims whose routes never saved: each one nothing has made a
 * record for yet, which under the resource's lock is all of them.
 */
const releaseWebHostnameClaimsEffect = Effect.fnUntraced(function* (
  rows: ReadonlyArray<WebHostname>
) {
  for (const row of rows) {
    const current = yield* loadWebHostnameEffect(row.id)
    if (current && !current.recordId) yield* deleteWebHostnameEffect(current)
  }
})

/**
 * Hostnames not yet held, lowercased, each once, names before their `www`
 * counterparts so a counterpart can follow its name.
 */
function freshHostnames(
  hostnames: ReadonlyArray<string>,
  held: ReadonlyMap<string, WebHostname>
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
 * name the resource holds: a web route's, or the game server's own address.
 */
const counterpartZoneEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  hostname: string,
  held: ReadonlyMap<string, WebHostname>
) {
  if (!hostname.startsWith("www.")) return null
  const baseName = hostname.slice(4)
  const base = held.get(baseName)
  if (base) {
    return base.vanityDomain
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
 * Holds a hostname for a resource, in the zone Kiln may make its record in.
 * Null when there's none; fails when another resource holds it. A `www`
 * counterpart of a vanity name the resource holds goes in that name's zone.
 * A game server's own address is held too, in its domain's zone, so a route
 * on it keeps the name once the domain moves off it.
 */
const claimHostnameEffect = Effect.fnUntraced(function* (
  resource: WebHostnameResource,
  hostname: string,
  ownerId: string | null,
  actor: DomainActor,
  held: ReadonlyMap<string, WebHostname>
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
    generated: false,
    hostname,
    id,
    vanityDomain: zone.vanityDomain,
    zoneId: zone.zoneId,
  })
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
        loadClaimedLabelsEffect(domain.domain),
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
        // Taken meanwhile: try the next name.
        Effect.catchTag("HostnameInUseError", () => Effect.succeed(false))
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
 * alone and marked `external`; one Kiln made for this game server or app,
 * whose ID it never heard back, is taken up again. One that looks in step
 * is left alone too, unless `verify` asks Cloudflare, as Sync does, so a
 * record deleted there is made again. Reports whether it had work to do.
 */
const reconcileWebHostnameEffect = Effect.fn("webHostnames.reconcile")(
  function* (row: WebHostname, target: string, verify = false) {
    if (row.status === "removing") {
      yield* removeWebHostnameEffect(row)
      return true
    }
    const record = cloudflareAddressRecord(row.hostname, target)
    if (
      !verify &&
      row.status === "active" &&
      row.recordId &&
      row.target === target &&
      row.recordType === record.type
    ) {
      return false
    }
    // Claimed by a save that failed: held, without a record, until a save
    // says the routes use it.
    if (!row.routed && !row.generated && !row.recordId) return false
    // The game server's own address: its domain keeps the record.
    if (!row.recordId && (yield* webHostnameCoveredEffect(row))) {
      if (row.status === "active") return false
      yield* markWebHostnameCoveredEffect(row.id)
      return true
    }
    const comment = webRecordComment(row)
    const sync = Effect.gen(function* () {
      const { apiToken } = yield* loadDomainConnectionCredentialEffect(
        row.connectionId
      )
      const pointAt = (recordId: string, recordType: string | null) =>
        recordType === record.type
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
      if (row.recordId) {
        const updated = yield* pointAt(row.recordId, row.recordType)
        // Deleted in Cloudflare meanwhile: make it again below. Any other
        // failure keeps the record Kiln made, to retry.
        if (!updated) yield* clearWebHostnameRecordEffect(row.id)
        else {
          yield* activateWebHostnameEffect({
            id: row.id,
            recordId: updated.id,
            recordType: record.type,
            target,
          })
          return
        }
      }
      const existing = yield* listCloudflareRecordsEffect(
        apiToken,
        row.zoneId,
        row.hostname
      )
      // Made by an attempt that stopped before it saved the record's ID.
      const marker = webRecordMarker(row)
      const lost = existing.find((found) => found.comment?.includes(marker))
      if (lost) {
        const adopted = yield* pointAt(lost.id, lost.type)
        if (adopted) {
          yield* activateWebHostnameEffect({
            id: row.id,
            recordId: adopted.id,
            recordType: record.type,
            target,
          })
          return
        }
      } else if (existing.length > 0) {
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
      const kept = yield* activateWebHostnameEffect({
        id: row.id,
        recordId: created.id,
        recordType: record.type,
        target,
      })
      // Let go while Cloudflare made it, as removing its connection or
      // Relay does: nothing would delete it later.
      if (!kept) {
        yield* deleteCloudflareRecordEffect(apiToken, row.zoneId, created.id)
      }
    })
    yield* sync.pipe(
      Effect.tapError((error) =>
        setWebHostnameStatusEffect(row.id, "error", error.message).pipe(
          Effect.ignore
        )
      )
    )
    return true
  }
)

/**
 * Deletes a hostname's records and forgets it, letting go of its name. Also
 * any record Kiln made for it but never heard back about, as when a create
 * or a replacement lost its answer: those carry the hostname's marker. One
 * Cloudflare refuses stays `removing`, with why, for the DNS worker. A
 * game server's own address keeps its domain's record.
 */
const removeWebHostnameEffect = Effect.fn("webHostnames.remove")(function* (
  row: WebHostname
) {
  if (!row.recordId && (yield* webHostnameCoveredEffect(row))) {
    return yield* deleteWebHostnameEffect(row)
  }
  const recordId = row.recordId
  yield* setWebHostnameStatusEffect(row.id, "removing", null)
  yield* loadDomainConnectionCredentialEffect(row.connectionId).pipe(
    Effect.flatMap(({ apiToken }) =>
      Effect.gen(function* () {
        if (recordId) {
          yield* deleteCloudflareRecordEffect(apiToken, row.zoneId, recordId)
        }
        yield* deleteLostWebRecordsEffect(apiToken, row)
      })
    ),
    Effect.andThen(deleteWebHostnameEffect(row)),
    Effect.tapError((error) =>
      setWebHostnameStatusEffect(
        row.id,
        "removing",
        `Delete failed: ${error.message}`
      ).pipe(Effect.ignore)
    )
  )
})

/**
 * Releases one hostname, such as an app's generated address, as it is once
 * work already on it finishes, and only while it's still the resource's.
 */
export const releaseWebHostnameEffect = Effect.fn("webHostnames.release")(
  function* (row: WebHostname) {
    yield* withCurrentRow(row, (current) =>
      Effect.gen(function* () {
        // A route's hostname follows its route; deleting it alone would let
        // another resource take a name the route still serves.
        if (!current.generated) {
          return yield* DomainConfigurationError.make({
            message: `Remove the web route to delete ${current.hostname}`,
          })
        }
        if (current.routed) {
          return yield* DomainConfigurationError.make({
            message: `A web route uses ${current.hostname}. Remove it from the routes first.`,
          })
        }
        yield* removeWebHostnameEffect(current)
      })
    )
  }
)

/** Deletes every record a deleted game server or app had. */
export const deleteResourceWebHostnamesEffect = Effect.fn(
  "webHostnames.deleteResource"
)(
  function* (resource: WebHostnameResource) {
    const rows = yield* listResourceWebHostnamesEffect(resource)
    // All marked first, so any delete that fails is finished by the DNS
    // worker, whichever it was.
    yield* markWebHostnamesRemovingEffect(rows.map((row) => row.id))
    let failure: unknown = null
    for (const row of rows) {
      yield* removeWebHostnameEffect(row).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            failure ??= error
          })
        )
      )
    }
    if (failure !== null) return yield* Effect.fail(failure)
    return rows.length
  },
  (effect, resource) => withResourceLock(resource, effect)
)

/**
 * Hands a game server's hostnames, with their names, to the one that takes
 * its place, as moving it to another Relay does, and points them at the new
 * Relay.
 */
export const moveResourceWebHostnamesEffect = Effect.fn("webHostnames.move")(
  function* (from: WebHostnameResource, to: WebHostnameResource) {
    const moved = yield* withResourceLock(
      from,
      withResourceLock(to, reassignWebHostnamesEffect(from, to))
    )
    // Also when a run cut short before this moved them and this run moved
    // none: their records still point at the old Relay until now.
    yield* reconcileResourceWebHostnamesEffect(to).pipe(Effect.ignore)
    publishWebHostnameChange([from.relayId, to.relayId])
    return moved
  }
)

/**
 * Forgets a removed Relay's hostnames, deleting their records first when
 * asked. Reports how many it had.
 */
export const removeRelayWebHostnamesEffect = Effect.fn(
  "webHostnames.removeRelay"
)(function* (relayId: string, removeRecords: boolean) {
  const rows = yield* listWebHostnamesEffect({ relayId })
  if (removeRecords) {
    // Marked first, so one whose delete fails, or is cut short, is
    // finished by the DNS worker. Each goes as it is under its lock, still
    // on this Relay, whatever a route save under way did to its mark.
    yield* markRelayWebHostnamesRemovingEffect(relayId)
    for (const row of rows) {
      yield* withCurrentRow(row, removeWebHostnameEffect).pipe(Effect.ignore)
    }
  } else {
    yield* deleteRelayWebHostnamesEffect(relayId)
  }
  return rows.length
})

/**
 * Runs `effect` on a hostname as it is under its resource's lock, so work
 * on it that started first, such as making its record, finishes first.
 * Skips it once it's gone, or moved to another resource.
 */
function withCurrentRow<E, R>(
  row: WebHostname,
  effect: (current: WebHostname) => Effect.Effect<unknown, E, R>
) {
  return withResourceLock(
    row,
    Effect.gen(function* () {
      const current = yield* loadWebHostnameEffect(row.id)
      if (current && sameOwner(current, row)) yield* effect(current)
    })
  )
}

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
        // A delete needs no Relay, as one left by removing its Relay.
        if (row.status === "removing") {
          yield* withCurrentRow(row, removeWebHostnameEffect)
          return null
        }
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
            if (!current || !sameOwner(current, row)) return null
            yield* reconcileWebHostnameEffect(current, relayTarget, true)
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

/**
 * The note on a record Kiln makes for a web hostname, naming its owner. Its
 * marker is the hostname's own ID, which stays the same when its game
 * server moves.
 */
function webRecordComment(row: WebHostname): string {
  const owner =
    row.resourceType === "app"
      ? `app ${row.resourceId}`
      : `a web route of server ${row.resourceId}`
  return `Managed by Kiln for ${owner} (${webRecordMarker(row)})`
}

function webRecordMarker(row: WebHostname): string {
  return `kiln:${row.id}`
}

/** Deletes the records Kiln made for a hostname but never heard back about. */
const deleteLostWebRecordsEffect = Effect.fnUntraced(function* (
  apiToken: string,
  row: WebHostname
) {
  const marker = webRecordMarker(row)
  const records = yield* listCloudflareRecordsEffect(
    apiToken,
    row.zoneId,
    row.hostname
  )
  for (const record of records) {
    if (record.comment?.includes(marker)) {
      yield* deleteCloudflareRecordEffect(apiToken, row.zoneId, record.id)
    }
  }
})

export function publishWebHostnameChange(relayIds: ReadonlyArray<string>) {
  publishRealtimeChange({
    audience: { kind: "relays", relayIds: [...new Set(relayIds)] },
    topics: ["domains"],
    type: "hearth.invalidate",
  })
}
