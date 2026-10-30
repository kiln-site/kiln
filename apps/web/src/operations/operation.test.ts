import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

// Registers resource deletion, whose locks a restart takes back.
import "@/lib/resource-deletion.server"
import { restoreLockingOperations } from "./durable"
import { exclusive, partKey, resourceKey, shared } from "./lanes"
import { operation, runOperation } from "./operation"
import { finishOperation, recordOperation } from "./records"

afterAll(() => disposeAppRuntime())

const person = { id: "person-one", name: "Sam" } as AuthenticatedUser
const server = resourceKey("instance", "relay-one", "alpha")
const serverDns = partKey(server, "dns")

// An operation that runs until the test lets it end.
const holding = (
  name: string,
  doing: string,
  locks: Array<ReturnType<typeof shared>>
) =>
  operation<Deferred.Deferred<void>>()({
    doing,
    locks: () => locks,
    name,
    run: ({ input }) => Deferred.await(input),
  })

const changeDns = operation<void>()({
  doing: "Changing this game server's domains",
  locks: () => [exclusive(serverDns)],
  name: "test.dns",
  run: () => Effect.succeed("changed"),
})

describeMysql("Hearth operations", () => {
  layer(TestDatabase, { timeout: 60_000 })((it) => {
    it.effect(
      "refuses a person's conflicting change with what's running, while Hearth's own waits",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const release = yield* Deferred.make<void>()
          const deleting = yield* runOperation(
            holding("test.delete", "Deleting this game server", [
              exclusive(server),
            ]),
            release,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow

          // A part of what the deletion holds whole.
          const refused = yield* runOperation(changeDns, undefined, {
            user: person,
          }).pipe(Effect.flip)
          assert.strictEqual(refused._tag, "OperationBusyError")
          assert.strictEqual(
            refused.message,
            "Deleting this game server is in progress. Try again once it's done."
          )
          // Something else entirely runs meanwhile.
          const other = yield* runOperation(
            operation<void>()({
              doing: "Changing another server",
              locks: () => [
                exclusive(resourceKey("instance", "relay-one", "beta")),
              ],
              name: "test.other",
              run: () => Effect.succeed("ran"),
            }),
            undefined,
            { user: person }
          )
          assert.strictEqual(other, "ran")

          // Hearth's own change waits for the deletion, then runs.
          const waiting = yield* runOperation(changeDns, undefined, {
            user: null,
          }).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          assert.isUndefined(waiting.pollUnsafe())
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(deleting)
          assert.strictEqual(yield* Fiber.join(waiting), "changed")
        })
    )

    it.effect(
      "runs an operation inside one that holds its locks, and refuses one needing more",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const inside = operation<void>()({
            doing: "Deleting this game server",
            locks: () => [exclusive(server)],
            name: "test.delete",
            run: () => runOperation(changeDns, undefined, { user: null }),
          })
          // The deletion holds the whole server, so its DNS is covered.
          assert.strictEqual(
            yield* runOperation(inside, undefined, { user: person }),
            "changed"
          )

          const needsMore = operation<void>()({
            doing: "Changing its DNS",
            locks: () => [exclusive(serverDns)],
            name: "test.dnsOnly",
            run: () =>
              runOperation(
                operation<void>()({
                  doing: "Changing the Relay",
                  locks: () => [exclusive("relay:relay-one")],
                  name: "test.relay",
                  run: () => Effect.void,
                }),
                undefined,
                { user: null }
              ),
          })
          const died = yield* runOperation(needsMore, undefined, {
            user: person,
          }).pipe(Effect.exit)
          assert.isTrue(died._tag === "Failure")
          // Nothing it took is left held.
          assert.strictEqual(
            yield* runOperation(changeDns, undefined, { user: person }),
            "changed"
          )
        })
    )

    it.effect(
      "takes back a durable operation's locks after a restart, until it ends",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          // Left running by a Hearth that stopped.
          const deletion = yield* recordOperation({
            input: {
              attempt: 1,
              deletionId: "deletion-one",
              kind: "instance",
              relayId: "relay-one",
              resourceId: "alpha",
            },
            kind: "resource.delete",
            locks: [exclusive(server)],
            version: 1,
          })
          yield* restoreLockingOperations

          const refused = yield* runOperation(changeDns, undefined, {
            user: person,
          }).pipe(Effect.flip)
          assert.strictEqual(
            refused.message,
            "Deleting this game server is in progress. Try again once it's done."
          )

          yield* finishOperation(deletion.id, "succeeded")
          assert.strictEqual(
            yield* runOperation(changeDns, undefined, { user: person }).pipe(
              Effect.eventually,
              Effect.timeout("5 seconds")
            ),
            "changed"
          )
        }).pipe(TestClock.withLive)
    )
  })
})
