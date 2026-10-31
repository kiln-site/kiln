import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Scheduler, Schema } from "effect"
import { TestClock } from "effect/testing"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"

// Registers resource deletion, whose locks a restart takes back.
import "@/lib/resource-deletion.server"
import {
  cancelQueuedOperation,
  durableOperation,
  queueDurableOperation,
  readmitWaitingOperations,
  restoreLockingOperations,
  startDurableOperation,
} from "./durable"
import {
  closeLanes,
  exclusive,
  hearthLanes,
  laneOccupants,
  partKey,
  resourceKey,
  shared,
} from "./lanes"
import { inLanes, operation, runOperation } from "./operation"
import {
  findOperation,
  finishOperation,
  loadOperation,
  recordOperation,
  waitingOperation,
} from "./records"

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
      "keeps a person waiting behind the same kind of change only, then checks them again",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const power = partKey(server, "power")
          const release = yield* Deferred.make<void>()
          const starting = yield* runOperation(
            holding("test.power", "Starting this game server", [
              exclusive(power),
            ]),
            release,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow

          // Other everyday work on the server runs beside it.
          const saved = yield* runOperation(
            operation<void>()({
              doing: "Saving a file",
              locks: () => [shared(server)],
              name: "test.save",
              run: () => Effect.succeed("saved"),
            }),
            undefined,
            { user: person }
          )
          assert.strictEqual(saved, "saved")

          // Another power action waits its turn, and is checked again once
          // it has: one no longer allowed by then doesn't run.
          let allowed = true
          let ran = false
          const stopping = yield* runOperation(
            operation<void>()({
              authorize: () =>
                Effect.suspend(() =>
                  allowed
                    ? Effect.void
                    : Effect.fail(new Error("No longer allowed"))
                ),
              doing: "Stopping this game server",
              locks: () => [exclusive(power)],
              name: "test.power.stop",
              run: () => Effect.sync(() => (ran = true)),
            }),
            undefined,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          assert.isUndefined(stopping.pollUnsafe())
          allowed = false
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(starting)
          const refused = yield* Fiber.join(stopping).pipe(Effect.flip)
          assert.strictEqual((refused as Error).message, "No longer allowed")
          assert.isFalse(ran)
        })
    )

    it.effect("tells a person what's in the way once they've waited long", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const power = partKey(server, "power")
        const release = yield* Deferred.make<void>()
        const starting = yield* runOperation(
          holding("test.power", "Starting this game server", [
            exclusive(power),
          ]),
          release,
          { user: person }
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow

        const waiting = yield* runOperation(
          holding("test.power.stop", "Stopping this game server", [
            exclusive(power),
          ]),
          release,
          { user: person }
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        yield* TestClock.adjust("30 seconds")
        const refused = yield* Fiber.join(waiting).pipe(Effect.flip)
        assert.strictEqual(refused._tag, "OperationBusyError")
        assert.strictEqual(
          refused.message,
          "Starting this game server is in progress. Try again once it's done."
        )

        // It gave up its place: the next power action runs once the first
        // ends.
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(starting)
        assert.strictEqual(
          yield* runOperation(
            operation<void>()({
              doing: "Restarting this game server",
              locks: () => [exclusive(power)],
              name: "test.power.restart",
              run: () => Effect.succeed("restarted"),
            }),
            undefined,
            { user: person }
          ),
          "restarted"
        )
      })
    )

    it.effect(
      "takes its turn again when what it changes moved while it waited",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const settingsOf = (id: string) =>
            partKey(`backup-storage:${id}`, "settings")
          const releaseFirst = yield* Deferred.make<void>()
          const releaseSecond = yield* Deferred.make<void>()
          const savingFirst = yield* runOperation(
            holding("test.storage.save", "Saving this destination", [
              exclusive(settingsOf("first")),
            ]),
            releaseFirst,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          const savingSecond = yield* runOperation(
            holding("test.storage.save", "Saving this destination", [
              exclusive(settingsOf("second")),
            ]),
            releaseSecond,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow

          // A backup to the preferred destination, which changes while it
          // waits for the first one's save.
          let preferred = "first"
          const backingUp = yield* runOperation(
            operation<void>()({
              authorize: () => Effect.sync(() => preferred),
              doing: "Backing up this game server",
              locks: ({ context }) => [shared(settingsOf(context))],
              name: "test.backup",
              run: ({ context }) => Effect.succeed(context),
            }),
            undefined,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          preferred = "second"
          yield* Deferred.succeed(releaseFirst, undefined)
          yield* Fiber.join(savingFirst)
          yield* Effect.yieldNow

          // It doesn't run without the second's lock, which is still held.
          assert.isUndefined(backingUp.pollUnsafe())
          yield* Deferred.succeed(releaseSecond, undefined)
          yield* Fiber.join(savingSecond)
          assert.strictEqual(yield* Fiber.join(backingUp), "second")
        })
    )

    it.effect("keeps a person waiting 30 seconds in all, however often", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const settingsOf = (id: string) =>
          partKey(`backup-storage:${id}`, "settings")
        const releaseFirst = yield* Deferred.make<void>()
        const releaseSecond = yield* Deferred.make<void>()
        const savingFirst = yield* runOperation(
          holding("test.storage.save", "Saving the first destination", [
            exclusive(settingsOf("first")),
          ]),
          releaseFirst,
          { user: person }
        ).pipe(Effect.forkChild({ startImmediately: true }))
        const savingSecond = yield* runOperation(
          holding("test.storage.save", "Saving the second destination", [
            exclusive(settingsOf("second")),
          ]),
          releaseSecond,
          { user: person }
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow

        let preferred = "first"
        const backingUp = yield* runOperation(
          operation<void>()({
            authorize: () => Effect.sync(() => preferred),
            doing: "Backing up this game server",
            locks: ({ context }) => [shared(settingsOf(context))],
            name: "test.backup",
            run: ({ context }) => Effect.succeed(context),
          }),
          undefined,
          { user: person }
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        // 20 seconds behind the first, then its turn again behind the second.
        yield* TestClock.adjust("20 seconds")
        preferred = "second"
        yield* Deferred.succeed(releaseFirst, undefined)
        yield* Fiber.join(savingFirst)
        yield* Effect.yieldNow
        assert.isUndefined(backingUp.pollUnsafe())

        yield* TestClock.adjust("10 seconds")
        const refused = yield* Fiber.join(backingUp).pipe(Effect.flip)
        assert.strictEqual(refused._tag, "OperationBusyError")
        assert.strictEqual(
          refused.message,
          "Saving the second destination is in progress. Try again once it's done."
        )
        yield* Deferred.succeed(releaseSecond, undefined)
        yield* Fiber.join(savingSecond)
      })
    )

    it.effect(
      "turns a person away at once from a deletion still waiting its turn",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const release = yield* Deferred.make<void>()
          const saving = yield* runOperation(
            holding("test.save", "Saving a file", [shared(server)]),
            release,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          // Hearth's own deletion waits for the save.
          const deleting = yield* runOperation(
            holding("test.delete", "Deleting this game server", [
              exclusive(server),
            ]),
            release,
            { user: null }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow

          // A power action would only run after the deletion: it's told so.
          const refused = yield* runOperation(
            holding("test.power", "Starting this game server", [
              exclusive(partKey(server, "power")),
            ]),
            release,
            { user: person }
          ).pipe(Effect.flip)
          assert.strictEqual(refused._tag, "OperationBusyError")
          assert.strictEqual(
            refused.message,
            "Deleting this game server is in progress. Try again once it's done."
          )
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(saving)
          yield* Fiber.join(deleting)
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
      "takes back a durable operation's locks after a restart, until it ends, though it was recorded without them",
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
            // Recorded before operations kept their locks: its definition
            // still says what it holds.
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

    it.effect(
      "publishes a change whose caller gave up once it started, and authorizes again what waited",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const release = yield* Deferred.make<void>()
          const published: Array<string> = []
          const started = yield* Deferred.make<void>()
          const caller = yield* runOperation(
            operation<void>()({
              doing: "Deleting this game server",
              locks: () => [exclusive(server)],
              name: "test.delete",
              publish: () => {
                published.push("delete")
              },
              run: () =>
                Deferred.succeed(started, undefined).pipe(
                  Effect.andThen(Deferred.await(release))
                ),
            }),
            undefined,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Deferred.await(started)

          // Hearth's own change waits behind it, then reads again.
          let authorized = 0
          const waiting = yield* runOperation(
            operation<void>()({
              authorize: () => Effect.sync(() => ++authorized),
              doing: "Changing its DNS",
              locks: () => [exclusive(serverDns)],
              name: "test.dns",
              run: ({ context }) => Effect.succeed(context),
            }),
            undefined,
            { user: null }
          ).pipe(Effect.forkChild({ startImmediately: true }))

          // The person leaves; the deletion finishes and still publishes.
          yield* Fiber.interrupt(caller)
          yield* Deferred.succeed(release, undefined)
          assert.strictEqual(yield* Fiber.join(waiting), 2)
          assert.deepStrictEqual(published, ["delete"])
        })
    )

    it.effect(
      "admits a person's durable change as any other, checking them again",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const deploy = partKey(server, "deploy")
          const deploying = durableOperation({
            input: Schema.Struct({}),
            kind: "test.durable.deploy",
            locks: () => [exclusive(deploy)],
            run: () => Effect.void,
            version: 1,
          })
          const release = yield* Deferred.make<void>()
          const first = yield* runOperation(
            holding("test.deploy", "Deploying this game server", [
              exclusive(deploy),
            ]),
            release,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow

          // Behind the same kind of change it waits, and is checked again
          // once it has: one no longer allowed is never recorded.
          let allowed = true
          const authorize = Effect.suspend(() =>
            allowed ? Effect.void : Effect.fail(new Error("No longer allowed"))
          )
          const waiting = yield* startDurableOperation(
            deploying,
            {},
            { actorId: person.id, authorize, idempotencyKey: "revoked" }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sync(() =>
            [...laneOccupants.values()].some(
              (occupant) => occupant.name === "test.durable.deploy"
            )
          ).pipe(
            Effect.repeat({ until: (queued) => queued }),
            Effect.timeout("5 seconds")
          )
          assert.isUndefined(waiting.pollUnsafe())
          allowed = false
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          const refused = yield* Fiber.join(waiting).pipe(Effect.flip)
          assert.strictEqual((refused as Error).message, "No longer allowed")
          assert.isNull(yield* findOperation("test.durable.deploy", "revoked"))

          // Nor does starting it again hand back one it may not see.
          const kept = yield* startDurableOperation(
            deploying,
            {},
            { actorId: person.id, idempotencyKey: "kept" }
          )
          const again = yield* startDurableOperation(
            deploying,
            {},
            { actorId: person.id, authorize, idempotencyKey: "kept" }
          ).pipe(Effect.flip)
          assert.strictEqual((again as Error).message, "No longer allowed")
          yield* finishOperation(kept, "succeeded")
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "joins what's asked while one waits under its key, and queues another once it starts",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const deploy = partKey(server, "deploy")
          const release = yield* Deferred.make<void>()
          const holder = yield* runOperation(
            holding("test.deploy", "Deploying this game server", [
              exclusive(deploy),
            ]),
            release,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          const queued = durableOperation({
            input: Schema.Struct({ asks: Schema.Array(Schema.String) }),
            join: (waiting, asked) => ({
              asks: [...waiting.asks, ...asked.asks],
            }),
            kind: "test.durable.queued",
            locks: () => [exclusive(deploy)],
            run: () => Effect.void,
            version: 1,
          })
          const queue = (ask: string) =>
            queueDurableOperation(queued, { asks: [ask] }, { key: "alpha" })
          const record = (id: string) =>
            loadOperation(id).pipe(Effect.map((found) => found?.state))

          // Asked twice behind the deploy: one waits, and runs both asks.
          const first = yield* queue("one")
          assert.strictEqual(yield* queue("two"), first)
          assert.strictEqual(yield* record(first), "waiting")
          assert.deepStrictEqual(
            (yield* waitingOperation("test.durable.queued", "alpha"))?.input,
            { asks: ["one", "two"] }
          )

          // Its turn comes: it starts, and what's asked now queues behind it.
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
          yield* record(first).pipe(
            Effect.repeat({ until: (now) => now === "running" }),
            Effect.timeout("5 seconds")
          )
          const next = yield* queue("three")
          assert.notStrictEqual(next, first)
          assert.strictEqual(yield* record(next), "waiting")

          // Cancelled while it waits, it never starts, leaves the line at
          // once, and the key is free.
          assert.isTrue(yield* cancelQueuedOperation(next))
          assert.isNull(yield* waitingOperation("test.durable.queued", "alpha"))
          yield* Effect.sync(() =>
            [...laneOccupants.values()].some((held) => held.id === next)
          ).pipe(
            Effect.repeat({ until: (inLine) => !inLine }),
            Effect.timeout("5 seconds")
          )
          yield* finishOperation(first, "succeeded")
          yield* Effect.sleep("200 millis")
          assert.strictEqual(yield* record(next), "cancelled")
          assert.isFalse(yield* cancelQueuedOperation(first))
        }).pipe(TestClock.withLive)
    )

    it.effect("turns away Hearth's own work that's only worth doing now", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const release = yield* Deferred.make<void>()
        const holder = yield* runOperation(
          holding("test.deploy", "Deploying this game server", [
            exclusive(serverDns),
          ]),
          release,
          { user: person }
        ).pipe(Effect.forkChild({ startImmediately: true }))
        yield* Effect.yieldNow
        const poll = inLanes(
          "test.poll",
          "Polling",
          [exclusive(serverDns)],
          Effect.succeed("polled"),
          { onlyIfFree: true }
        )

        // Busy: turned away at once, rather than waiting behind it.
        const refused = yield* poll.pipe(Effect.flip)
        assert.strictEqual(
          (refused as { _tag?: string })._tag,
          "OperationBusyError"
        )

        // Free: it runs.
        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(holder)
        assert.strictEqual(yield* poll, "polled")
      }).pipe(TestClock.withLive)
    )

    it.effect(
      "holds one place in line for an operation, however many take it up",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const deploy = partKey(server, "deploy")
          const release = yield* Deferred.make<void>()
          const holder = yield* runOperation(
            holding("test.deploy", "Deploying this game server", [
              exclusive(deploy),
            ]),
            release,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow
          const queued = durableOperation({
            input: Schema.Struct({}),
            kind: "test.durable.once",
            locks: () => [exclusive(deploy)],
            run: () => Effect.void,
            version: 1,
          })
          // Its places in its lanes' line, as the lanes have them.
          const places = (id: string) =>
            hearthLanes
              .describe()
              .waiting.filter(
                (waiting) => waiting.label === `test.durable.once#${id}`
              ).length

          // Queued as startup takes back what's running, and taken up by
          // startup's sweep too: one place in line.
          const open = closeLanes()
          const id = yield* queueDurableOperation(queued, {})
          yield* readmitWaitingOperations
          yield* open
          yield* Effect.sleep("100 millis")
          assert.strictEqual(places(id), 1)

          // Cancelled, it leaves the line.
          assert.isTrue(yield* cancelQueuedOperation(id))
          yield* Effect.sync(() => places(id)).pipe(
            Effect.repeat({ until: (count) => count === 0 }),
            Effect.timeout("5 seconds")
          )
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "keeps one not ready waiting, still joined and cancellable, until it is",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          let ready = false
          const queued = durableOperation({
            input: Schema.Struct({ asks: Schema.Array(Schema.String) }),
            join: (waiting, asked) => ({
              asks: [...waiting.asks, ...asked.asks],
            }),
            kind: "test.durable.ready",
            locks: () => [exclusive(partKey(server, "deploy"))],
            ready: () => Effect.sync(() => ready),
            run: () => Effect.void,
            version: 1,
          })
          const queue = (ask: string) =>
            queueDurableOperation(queued, { asks: [ask] }, { key: "alpha" })
          const state = (id: string) =>
            loadOperation(id).pipe(Effect.map((found) => found?.state))

          // Its turn comes while what it needs isn't there: it gives its
          // turn back, and what's asked meanwhile still joins it.
          const id = yield* queue("one")
          yield* Effect.sleep("200 millis")
          assert.strictEqual(yield* state(id), "waiting")
          assert.strictEqual(yield* queue("two"), id)

          // Ready by the sweep after: it starts, with both asks.
          ready = true
          yield* readmitWaitingOperations
          yield* state(id).pipe(
            Effect.repeat({ until: (now) => now === "running" }),
            Effect.timeout("5 seconds")
          )
          assert.deepStrictEqual((yield* loadOperation(id))?.input, {
            asks: ["one", "two"],
          })
          yield* finishOperation(id, "succeeded")
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "queues durable changes past startup, and takes up one left waiting",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const queued = durableOperation({
            input: Schema.Struct({ name: Schema.String }),
            kind: "test.durable.checked",
            locks: ({ name }) => [exclusive(partKey(server, name))],
            run: () => Effect.void,
            version: 1,
          })
          const until = (id: string, wanted: string) =>
            loadOperation(id).pipe(
              Effect.map((found) => found?.state),
              Effect.repeat({ until: (now) => now === wanted }),
              Effect.timeout("5 seconds")
            )

          // While startup takes back what's running, it's recorded and waits.
          const open = closeLanes()
          const early = yield* queueDurableOperation(queued, { name: "early" })
          yield* Effect.sleep("100 millis")
          assert.strictEqual((yield* loadOperation(early))?.state, "waiting")
          yield* open
          yield* until(early, "running")

          // One waiting with nothing taking its turn, as a restart finds it,
          // takes its turn.
          const restored = yield* recordOperation({
            input: { name: "restored" },
            kind: "test.durable.checked",
            locks: [exclusive(partKey(server, "restored"))],
            state: "waiting",
            version: 1,
          })
          yield* readmitWaitingOperations
          yield* until(restored.id, "running")
          for (const id of [early, restored.id]) {
            yield* finishOperation(id, "succeeded")
          }
        }).pipe(TestClock.withLive)
    )

    it.effect(
      "never starts a durable change whose caller gave up while it waited",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const release = yield* Deferred.make<void>()
          const holder = yield* runOperation(
            holding("test.delete", "Deleting this game server", [
              exclusive(server),
            ]),
            release,
            { user: person }
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow

          const caller = yield* startDurableOperation(
            durableOperation({
              input: Schema.Struct({}),
              kind: "test.durable",
              locks: () => [exclusive(server)],
              run: () => Effect.void,
              version: 1,
            }),
            {},
            { idempotencyKey: "abandoned", initiator: "system" }
          ).pipe(
            // Yielding often, so giving up can land anywhere in its start.
            Effect.provideService(Scheduler.MaxOpsBeforeYield, 10),
            Effect.forkChild({ startImmediately: true })
          )
          // Queued behind the deletion before its caller gives up.
          yield* Effect.sync(() =>
            [...laneOccupants.values()].some(
              (occupant) => occupant.name === "test.durable"
            )
          ).pipe(
            Effect.repeat({ until: (queued) => queued }),
            Effect.timeout("5 seconds")
          )
          yield* Fiber.interrupt(caller)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(holder)
          yield* Effect.sleep("50 millis")

          assert.isNull(yield* findOperation("test.durable", "abandoned"))
          // And it left nothing behind holding the server.
          assert.strictEqual(
            yield* runOperation(
              holding("test.after", "Changing it", [exclusive(server)]),
              yield* Deferred.make<void>().pipe(
                Effect.tap((done) => Deferred.succeed(done, undefined))
              ),
              { user: person }
            ).pipe(Effect.as("ran")),
            "ran"
          )
        }).pipe(TestClock.withLive)
    )
  })
})
