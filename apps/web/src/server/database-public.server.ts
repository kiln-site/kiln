import { relayDatabasePublicStatusSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  listResourceAddressesEffect,
  listResourceWebHostnamesEffect,
  markAddressesRemovingEffect,
  type WebHostnameResource,
} from "@/effect/addresses"
import { DomainConfigurationError, HostnameInUseError } from "@/effect/errors"
import { canonicalHostname } from "@/effect/hostname-claims"
import { promiseEffect } from "@/effect/promise"
import { dnsKey } from "@/lib/dns-operations"
import { requireRelayPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { exclusive, partKey, resourceKey, shared } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"
import {
  generateAppHostnameEffect,
  publishWebHostnameChange,
  reconcileResourceAddressesEffect,
  saveWebRouteHostnamesEffect,
} from "@/server/addresses.server"
import { domainActor } from "@/server/domain-access.server"
import { explainHostnameInUseEffect } from "@/server/domain-resource-access.server"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"

// A database's public names are rows of its Domains table, as an App's are:
// added, renamed and deleted there, each held by it alone, with a record that
// points at its Relay and never goes through Cloudflare's proxy. One with a
// name is open to the internet at a port, the same for each; one without is
// closed. Its Relay's Traefik gets a certificate for each name, and its gate
// holds the port and serves them. The Relay keeps the port and the names it was given,
// and says how opening it stands in the database's listing.

interface DatabasePublicScope {
  databaseId: string
  relayId: string
}

const databaseResource = (scope: DatabasePublicScope): WebHostnameResource => ({
  relayId: scope.relayId,
  resourceId: scope.databaseId,
  resourceType: "database",
})

/**
 * What changing whether a database is public, or its names, holds: one
 * change at a time, beside the database's other everyday changes, with
 * deleting it turning them away, and its names' DNS records.
 */
export const databasePublicLocks = (scope: DatabasePublicScope) => [
  shared(resourceKey("database", scope.relayId, scope.databaseId)),
  exclusive(
    partKey(resourceKey("database", scope.relayId, scope.databaseId), "public")
  ),
  exclusive(dnsKey(databaseResource(scope))),
]

const authorizePublic = ({
  input,
  user,
}: {
  input: DatabasePublicScope
  user: Parameters<typeof signedIn>[0]
}) =>
  signedIn(user).pipe(
    Effect.tap((person) =>
      promiseEffect(() =>
        requireRelayPermission({
          databaseId: input.databaseId,
          permission: "database.network.public-port.write",
          relayId: input.relayId,
          user: person,
        })
      )
    )
  )

/** Tells the database's pages, and every Domains table, what changed. */
export const publishDatabasePublicChange = (scope: DatabasePublicScope) =>
  Effect.sync(() => {
    publishWebHostnameChange([scope.relayId])
    publishRealtimeChange({
      audience: { kind: "relays", relayIds: [scope.relayId] },
      scope: { relayId: scope.relayId },
      topics: ["databases"],
      type: "hearth.invalidate",
    })
  })

// Whether the database is open to the internet, or opening, on its Relay,
// and at which port.
async function publicNow(
  relay: Awaited<ReturnType<typeof requiredRelay>>,
  databaseId: string,
  userId: string
): Promise<{ hostnames: ReadonlyArray<string>; port: number } | null> {
  const [item] = z
    .array(
      z
        .object({
          database: z
            .object({ public: relayDatabasePublicStatusSchema.nullable() })
            .loose()
            .optional(),
        })
        .loose()
    )
    .parse(
      await databaseRpc(
        relay,
        "database.list",
        { requests: [{ id: databaseId, view: "detail" }] },
        30_000,
        userId
      )
    )
  if (!item?.database) throw new Error("Database not found")
  return item.database.public
}

// Tells its Relay its names and port, or that it's closed.
const writePublic = (
  relay: Awaited<ReturnType<typeof requiredRelay>>,
  databaseId: string,
  userId: string,
  value: { hostnames: Array<string>; port: number } | null
) =>
  promiseEffect(() =>
    databaseRpc(
      relay,
      "database.public.write",
      // In one order, so the same names are the same certificate.
      {
        databaseId,
        public: value && { ...value, hostnames: [...value.hostnames].sort() },
      },
      30_000,
      userId
    )
  )

// Its names, as its Domains table lists them.
const namesOf = (resource: WebHostnameResource) =>
  listResourceWebHostnamesEffect(resource).pipe(
    Effect.map((rows) =>
      rows.filter((row) => row.status !== "removing").map((row) => row.hostname)
    )
  )

/** What a database's Domains table saves. */
export interface DatabaseNamesChange {
  // Also a name generated under its owner's default vanity domain, or
  // Kiln's, as an App's first address is.
  generate?: boolean
  hostnames: ReadonlyArray<string>
  // The port all its names are reached at; the one it has when left out.
  port?: number
}

/**
 * Gives a database these names, as its Domains table saves them, and the
 * port they're reached at. A database with a name is open to the internet
 * and one without is closed: its first name opens it, and deleting its last
 * closes it. Each new name is claimed as a web route's is, and refused the
 * same way; one it no longer lists is let go, its record deleted. Its Relay
 * gets them first, for their certificates. A change its Relay
 * refuses leaves it as it was. The caller holds `databasePublicLocks`.
 */
export const saveDatabaseNamesEffect = Effect.fn("databases.names.save")(
  function* (
    scope: DatabasePublicScope,
    change: DatabaseNamesChange,
    person: AuthenticatedUser
  ) {
    const resource = databaseResource(scope)
    const relay = yield* promiseEffect(() => requiredRelay(scope.relayId))
    const open = yield* promiseEffect(() =>
      publicNow(relay, scope.databaseId, person.id)
    )
    const before = new Set(yield* namesOf(resource))
    const wanted = [...new Set(change.hostnames.map(canonicalHostname))]
    const write = (value: { hostnames: Array<string>; port: number } | null) =>
      writePublic(relay, scope.databaseId, person.id, value)
    const save = <R>(
      hostnames: ReadonlyArray<string>,
      relayChange: Effect.Effect<unknown, unknown, R>
    ) =>
      saveWebRouteHostnamesEffect(
        { actor: domainActor(person), hostnames, resource },
        relayChange
      ).pipe(
        Effect.catchIf(
          (error): error is HostnameInUseError =>
            error instanceof HostnameInUseError,
          (error) => explainHostnameInUseEffect(person, error)
        )
      )

    if (wanted.length === 0 && !change.generate) {
      // Closed: its Relay removes its gate before its names go, so nothing
      // reaches it at a name another instance may take next.
      yield* save([], open ? write(null) : Effect.void)
    } else {
      const port = change.port ?? open?.port
      if (port === undefined) {
        return yield* DomainConfigurationError.make({
          message: "Choose the port it's reached at",
        })
      }
      yield* Effect.gen(function* () {
        if (change.generate) {
          const generated = yield* generateAppHostnameEffect(resource)
          if (!generated) {
            return yield* DomainConfigurationError.make({
              message:
                "Kiln has no vanity domain to name it under. Add one on the Domains page, or enter a domain.",
            })
          }
          if (!wanted.includes(generated)) wanted.push(generated)
        }
        yield* save(
          wanted,
          Effect.gen(function* () {
            // Only a name it holds: its certificate is asked for at each.
            const held = new Set(
              (yield* listResourceAddressesEffect(resource)).map(
                (row) => row.hostname
              )
            )
            const loose = wanted.find((hostname) => !held.has(hostname))
            if (loose) {
              return yield* DomainConfigurationError.make({
                message: `${loose} isn't under a domain on the Domains page. Connect its Cloudflare zone, or add it as managed elsewhere.`,
              })
            }
            yield* write({ hostnames: wanted, port })
          })
        )
      }).pipe(
        // Refused, it stays as it was: its Relay is given back what it had,
        // in case it saved the change before its answer was lost, and only
        // then do the names this claimed go. Unsure, they stay claimed.
        Effect.tapError(() =>
          Effect.gen(function* () {
            yield* write(
              open ? { hostnames: [...open.hostnames], port: open.port } : null
            )
            yield* markAddressesRemovingEffect(
              (yield* listResourceAddressesEffect(resource))
                .filter(
                  (row) =>
                    row.status !== "removing" && !before.has(row.hostname)
                )
                .map((row) => row.id)
            )
            yield* reconcileResourceAddressesEffect(resource)
          }).pipe(Effect.ignore)
        )
      )
    }
    // A generated name goes too once it's no longer listed, as a web
    // route's doesn't.
    const set = new Set(wanted)
    yield* markAddressesRemovingEffect(
      (yield* listResourceAddressesEffect(resource))
        .filter(
          (row) =>
            row.generated && row.status !== "removing" && !set.has(row.hostname)
        )
        .map((row) => row.id)
    )
    yield* reconcileResourceAddressesEffect(resource).pipe(
      // Each name's row shows what failed; the DNS worker retries it.
      Effect.ignore
    )
  }
)

/**
 * Saves the names in a database's Domains table, and the port they're
 * reached at: opening it to the internet, changing it, or closing it.
 */
export const saveDatabaseNames = operation<
  DatabasePublicScope & DatabaseNamesChange
>()({
  name: "database.names.save",
  doing: "Changing this database's domains",
  authorize: authorizePublic,
  locks: ({ input }) => databasePublicLocks(input),
  run: ({ context: person, input }) =>
    saveDatabaseNamesEffect(input, input, person),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
  // A failed save can still have changed a name.
  publish: ({ input }) => publishDatabasePublicChange(input),
})
