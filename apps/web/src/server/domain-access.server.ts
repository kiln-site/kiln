import type { RowDataPacket } from "mysql2/promise"
import { Effect, Random } from "effect"

import { Database } from "@/effect/database"
import {
  countInstanceDomainsByDomainEffect,
  listUsableVanityDomainsEffect,
  loadVanitySettingsEffect,
  type ManagedDomain,
  type VanitySettings,
} from "@/effect/domains"
import { isPlatformAdmin } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { resourceOwnerQuery } from "@/lib/resource-owners"

/**
 * Who is asking for a domain. Their own Cloudflare connections are theirs to
 * use; an owner's only when they are that owner; the platform's whole zones
 * only for platform administrators. Everyone may name things under the
 * platform's vanity domains.
 */
export interface DomainActor {
  readonly admin: boolean
  readonly id: string
}

export function domainActor(user: AuthenticatedUser): DomainActor {
  return { admin: isPlatformAdmin(user), id: user.id }
}

/** Who owns a game server or app, or null when nobody does. */
export const loadResourceOwnerIdEffect = Effect.fn("domains.resource.owner")(
  function* (scope: {
    relayId: string
    resourceId: string
    resourceType: "app" | "instance"
  }) {
    const database = yield* Database
    const query = resourceOwnerQuery(scope)
    const rows = yield* database.queryRows<
      RowDataPacket & { user_id: string | null }
    >("domains.resource.owner", query.sql, query.values)
    return rows[0]?.user_id ?? null
  }
)

/**
 * Whether a resource owned by `ownerId` may have an address under `domain`:
 * the platform's domains are everyone's, a person's are theirs and their
 * resources', and administrators may use any.
 */
export function vanityDomainUsable(
  domain: Pick<ManagedDomain, "ownerId">,
  ownerId: string | null,
  actor: DomainActor | null
): boolean {
  return (
    domain.ownerId === null ||
    domain.ownerId === ownerId ||
    (actor !== null && (actor.admin || domain.ownerId === actor.id))
  )
}

/**
 * The vanity domain a new game server's or app's address goes under, with
 * the settings it was picked by. An owner with vanity domains of their own
 * uses those, and only those; everyone else gets the platform's. Null when
 * the settings that apply turn automatic addresses off.
 */
export const chooseVanityDomainEffect = Effect.fn("domains.chooseDomain")(
  function* (ownerId: string | null) {
    const usable = yield* listUsableVanityDomainsEffect(ownerId)
    const own = usable.filter(
      (domain) => ownerId !== null && domain.ownerId === ownerId
    )
    const pool = own.length > 0 ? own : usable.filter((d) => !d.ownerId)
    const settings = yield* loadVanitySettingsEffect(
      own.length > 0 ? ownerId : null
    )
    // Loaded default first, so it wins ties.
    const domains = pool.filter((domain) => domain.enabled)
    const [fallback] = domains
    if (!fallback || !settings.autoAssign) return null
    const domain = yield* pickDomain(domains, fallback, settings)
    return { domain, settings }
  }
)

const pickDomain = Effect.fnUntraced(function* (
  domains: ReadonlyArray<ManagedDomain>,
  fallback: ManagedDomain,
  settings: VanitySettings
) {
  if (settings.strategy === "random") {
    const index = yield* Random.nextIntBetween(0, domains.length, {
      halfOpen: true,
    })
    return domains[index] ?? fallback
  }
  if (settings.strategy === "balanced") {
    const usage = yield* countInstanceDomainsByDomainEffect()
    return domains.reduce((least, domain) =>
      (usage.get(domain.domain) ?? 0) < (usage.get(least.domain) ?? 0)
        ? domain
        : least
    )
  }
  return domains.find((domain) => domain.isDefault) ?? fallback
})
