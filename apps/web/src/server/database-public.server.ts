import { relayDatabasePublicStatusSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { z } from "zod"

import {
  listResourceWebHostnamesEffect,
  type WebHostnameResource,
} from "@/effect/addresses"
import { DomainConfigurationError } from "@/effect/errors"
import { promiseEffect } from "@/effect/promise"
import { dnsKey } from "@/lib/dns-operations"
import { requireRelayPermission } from "@/lib/access-control"
import { publishRealtimeChange } from "@/lib/realtime-source.server"
import { exclusive, partKey, resourceKey, shared } from "@/operations/lanes"
import { operation, signedIn } from "@/operations/operation"
import {
  generateAppHostnameEffect,
  publishWebHostnameChange,
  releaseWebHostnameEffect,
} from "@/server/addresses.server"
import { databaseRpc, requiredRelay } from "@/server/managed-database-access"

// A database opened to the internet has one name, generated under its
// owner's default vanity domain, or Kiln's, as an App's first address is.
// Its record points at the Relay, never through Cloudflare's proxy: the
// Relay's Traefik gets the name's certificate, and the database's gate
// holds its port there. The Relay keeps the port, and says how opening it
// stands in the database's listing.

interface DatabasePublicScope {
  databaseId: string
  relayId: string
}

const databaseResource = (scope: DatabasePublicScope): WebHostnameResource => ({
  relayId: scope.relayId,
  resourceId: scope.databaseId,
  resourceType: "database",
})

// Opening and closing it, one at a time, beside the database's other
// everyday changes; deleting it turns them away. Each changes its name's
// DNS records too.
const publicLocks = ({ input }: { input: DatabasePublicScope }) => [
  shared(resourceKey("database", input.relayId, input.databaseId)),
  exclusive(
    partKey(resourceKey("database", input.relayId, input.databaseId), "public")
  ),
  exclusive(dnsKey(databaseResource(input))),
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

const published = ({ input }: { input: DatabasePublicScope }) =>
  Effect.sync(() => {
    publishWebHostnameChange([input.relayId])
    publishRealtimeChange({
      audience: { kind: "relays", relayIds: [input.relayId] },
      scope: { relayId: input.relayId },
      topics: ["databases"],
      type: "hearth.invalidate",
    })
  })

// Whether the database is open to the internet, or opening, on its Relay.
async function publicNow(
  relay: Awaited<ReturnType<typeof requiredRelay>>,
  databaseId: string,
  userId: string
): Promise<boolean> {
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
  return item.database.public !== null
}

/**
 * Opens a database to the internet at its name and `port` on its Relay, or
 * moves an open one to another port. It opens once the name resolves and
 * its certificate comes; until then its listing says what it waits for.
 */
export const openDatabasePublic = operation<
  DatabasePublicScope & { port: number }
>()({
  name: "database.public.open",
  doing: "Opening this database to the internet",
  authorize: authorizePublic,
  locks: publicLocks,
  run: ({ context: person, input }) =>
    Effect.gen(function* () {
      const resource = databaseResource(input)
      const relay = yield* promiseEffect(() => requiredRelay(input.relayId))
      // Whether it was open before, as its Relay says: a failed change to an
      // open one leaves it as it was, name and all.
      const wasOpen = yield* promiseEffect(() =>
        publicNow(relay, input.databaseId, person.id)
      )
      const kept = (yield* listResourceWebHostnamesEffect(resource)).find(
        (row) => row.status !== "removing"
      )
      const hostname =
        kept?.hostname ?? (yield* generateAppHostnameEffect(resource))
      if (!hostname) {
        return yield* DomainConfigurationError.make({
          message:
            "A public database gets a name under a vanity domain. Add one on the Domains page first.",
        })
      }
      const write = (value: { hostname: string; port: number } | null) =>
        promiseEffect(() =>
          databaseRpc(
            relay,
            "database.public.write",
            { databaseId: input.databaseId, public: value },
            30_000,
            person.id
          )
        )
      yield* write({ hostname, port: input.port }).pipe(
        // Its name goes again if its Relay won't open it, as one without
        // Kiln's Traefik, or with the port taken, even one a failed attempt
        // before kept. The Relay may have saved it before failing, or its
        // answer may have been lost, so it's closed there first; if that
        // fails too, the name stays until the next attempt or a close.
        Effect.tapError(() =>
          wasOpen
            ? Effect.void
            : write(null).pipe(
                Effect.andThen(listResourceWebHostnamesEffect(resource)),
                Effect.flatMap((rows) =>
                  Effect.forEach(
                    rows,
                    (row) =>
                      releaseWebHostnameEffect({ ...resource, id: row.id }),
                    { discard: true }
                  )
                ),
                Effect.ignore
              )
        )
      )
      return { hostname, port: input.port }
    }),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
  publish: published,
})

/**
 * Closes a public database: its Relay removes its gate first, so nothing
 * reaches it, then its name and record go.
 */
export const closeDatabasePublic = operation<DatabasePublicScope>()({
  name: "database.public.close",
  doing: "Closing this database to the internet",
  authorize: authorizePublic,
  locks: publicLocks,
  run: ({ context: person, input }) =>
    Effect.gen(function* () {
      const relay = yield* promiseEffect(() => requiredRelay(input.relayId))
      yield* promiseEffect(() =>
        databaseRpc(
          relay,
          "database.public.write",
          { databaseId: input.databaseId, public: null },
          30_000,
          person.id
        )
      )
      const resource = databaseResource(input)
      for (const row of yield* listResourceWebHostnamesEffect(resource)) {
        if (row.status === "removing") continue
        yield* releaseWebHostnameEffect({ ...resource, id: row.id })
      }
      return { closed: true }
    }),
  audit: ({ input }) => ({
    id: input.databaseId,
    kind: "database",
    relayId: input.relayId,
  }),
  publish: published,
})
