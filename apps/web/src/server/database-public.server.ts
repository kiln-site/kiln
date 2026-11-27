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

// A database's names are rows of its Domains table, as an App's are: added,
// renamed and deleted there, each held by it alone, with a record that points
// at its Relay and never goes through Cloudflare's proxy. Opening it to the
// internet gives it a port; while it's open, its Relay's Traefik gets one
// certificate for all its names, and its gate holds the port. Its names stay
// when it's closed. The Relay keeps the port and the names it was given, and
// says how opening it stands in the database's listing.

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
): Promise<{ port: number } | null> {
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

/**
 * Gives a database these names, as its Domains table saves them: each new
 * one is claimed as a web route's is, and refused the same way; one it no
 * longer lists is let go, its record deleted. While it's open its Relay
 * gets them first, for a certificate for them all, and it keeps at least
 * one. The caller holds `databasePublicLocks`.
 */
export const saveDatabaseNamesEffect = Effect.fn("databases.names.save")(
  function* (
    scope: DatabasePublicScope,
    hostnames: ReadonlyArray<string>,
    person: AuthenticatedUser
  ) {
    const resource = databaseResource(scope)
    const wanted = [...new Set(hostnames.map(canonicalHostname))]
    const relay = yield* promiseEffect(() => requiredRelay(scope.relayId))
    const open = yield* promiseEffect(() =>
      publicNow(relay, scope.databaseId, person.id)
    )
    if (open && wanted.length === 0) {
      return yield* DomainConfigurationError.make({
        message:
          "A database open to the internet keeps at least one name. Close it to delete its last.",
      })
    }
    yield* saveWebRouteHostnamesEffect(
      { actor: domainActor(person), hostnames: wanted, resource },
      Effect.gen(function* () {
        // Only a name it holds: its certificate is asked for at each one.
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
        if (open) {
          yield* writePublic(relay, scope.databaseId, person.id, {
            hostnames: wanted,
            port: open.port,
          })
        }
      })
    ).pipe(
      Effect.catchIf(
        (error): error is HostnameInUseError =>
          error instanceof HostnameInUseError,
        (error) => explainHostnameInUseEffect(person, error)
      )
    )
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

/** Saves the names in a database's Domains table. */
export const saveDatabaseNames = operation<
  DatabasePublicScope & { hostnames: Array<string> }
>()({
  name: "database.names.save",
  doing: "Changing this database's domains",
  authorize: authorizePublic,
  locks: ({ input }) => databasePublicLocks(input),
  run: ({ context: person, input }) =>
    saveDatabaseNamesEffect(input, input.hostnames, person),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
  // A failed save can still have claimed a name.
  publish: ({ input }) => publishDatabasePublicChange(input),
})

/**
 * Opens a database to the internet at its names and `port` on its Relay,
 * or moves an open one to another port. One with no name yet gets one
 * generated under its owner's default vanity domain, or Kiln's, as an
 * App's first address is. It opens once its names resolve and their
 * certificate comes; until then its listing says what it waits for.
 */
export const openDatabasePublic = operation<
  DatabasePublicScope & { port: number }
>()({
  name: "database.public.open",
  doing: "Opening this database to the internet",
  authorize: authorizePublic,
  locks: ({ input }) => databasePublicLocks(input),
  run: ({ context: person, input }) =>
    Effect.gen(function* () {
      const resource = databaseResource(input)
      const relay = yield* promiseEffect(() => requiredRelay(input.relayId))
      // Whether it was open before, as its Relay says: a failed change to an
      // open one leaves it as it was.
      const wasOpen = yield* promiseEffect(() =>
        publicNow(relay, input.databaseId, person.id)
      )
      let hostnames = yield* namesOf(resource)
      if (hostnames.length === 0) {
        const generated = yield* generateAppHostnameEffect(resource)
        if (!generated) {
          return yield* DomainConfigurationError.make({
            message:
              "A public database needs a name. Add one to its Domains table, or a vanity domain on the Domains page.",
          })
        }
        hostnames = [generated]
      }
      const write = (
        value: { hostnames: Array<string>; port: number } | null
      ) => writePublic(relay, input.databaseId, person.id, value)
      yield* write({ hostnames, port: input.port }).pipe(
        // The Relay may have saved it before failing, as one without Kiln's
        // Traefik or with the port taken, or its answer may have been lost,
        // so one that wasn't open is closed there again. Its names stay.
        Effect.tapError(() =>
          wasOpen ? Effect.void : write(null).pipe(Effect.ignore)
        )
      )
      return { hostnames, port: input.port }
    }),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
  publish: ({ input }) => publishDatabasePublicChange(input),
})

/**
 * Closes a public database: its Relay removes its gate, so nothing reaches
 * it. Its names stay in its Domains table, for the next time it opens.
 */
export const closeDatabasePublic = operation<DatabasePublicScope>()({
  name: "database.public.close",
  doing: "Closing this database to the internet",
  authorize: authorizePublic,
  locks: ({ input }) => databasePublicLocks(input),
  run: ({ context: person, input }) =>
    Effect.gen(function* () {
      const relay = yield* promiseEffect(() => requiredRelay(input.relayId))
      yield* writePublic(relay, input.databaseId, person.id, null)
      return { closed: true }
    }),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
  publish: ({ input }) => publishDatabasePublicChange(input),
})
