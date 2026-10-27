import type { RowDataPacket } from "mysql2/promise"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import {
  listUsableVanityDomainsEffect,
  type ManagedDomain,
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
 * Whether a vanity domain is the person's to arrange, its reserved names and
 * existing records included: their own, or Kiln's for administrators.
 */
export function ownsVanityDomain(
  domain: { ownerId: string | null },
  actor: DomainActor
): boolean {
  return domain.ownerId === null ? actor.admin : domain.ownerId === actor.id
}

/**
 * The vanity domain a new game server's or app's address goes under: the
 * owner's default when they have vanity domains of their own, otherwise the
 * shared default. Null when neither has any.
 */
export const chooseVanityDomainEffect = Effect.fn("domains.chooseDomain")(
  function* (ownerId: string | null) {
    const usable = yield* listUsableVanityDomainsEffect(ownerId)
    const offered = usable.filter((domain) => domain.enabled)
    const own = offered.filter(
      (domain) => ownerId !== null && domain.ownerId === ownerId
    )
    const pool = own.length > 0 ? own : offered.filter((d) => !d.ownerId)
    return pool.find((domain) => domain.isDefault) ?? pool[0] ?? null
  }
)
