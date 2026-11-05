import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { RelayUnavailableError } from "@/effect/errors"
import {
  createManagedDatabaseRecordEffect,
  encryptManagedDatabasePassword,
  loadManagedDatabaseCredentialEffect,
} from "@/effect/managed-databases"
import { disposeAppRuntime } from "@/effect/runtime"
import { startDurableOperation } from "@/operations/durable"
import { loadOperation } from "@/operations/records"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

import { changeDatabaseLogin } from "./database-credentials.server"

// The Relay is the only fake: what it was sent, its outcomes by command ID,
// and what goes wrong with the next change it's sent.
const relay = vi.hoisted(() => ({
  journal: new Map<string, unknown>(),
  next: [] as Array<"interrupted" | "loses-reply" | "refuses">,
  sent: [] as Array<Record<string, unknown>>,
  subjects: [] as Array<string | undefined>,
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayJournal: async () => ({ clientId: "hearth", journalId: "journal" }),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: Record<string, unknown>,
    _timeout?: number,
    subject?: string,
    _signal?: AbortSignal,
    frame: { operationId?: string } = {}
  ) => {
    if (operation === "operation.get") {
      return (
        relay.journal.get(String(payload.operationId)) ?? { status: "unknown" }
      )
    }
    const id = frame.operationId ?? ""
    relay.sent.push(payload)
    relay.subjects.push(subject)
    const outcome = relay.next.shift()
    if (outcome === "refuses") {
      relay.journal.set(id, {
        code: "database_error",
        message: 'role "taken" already exists',
        retryable: false,
        status: "failed",
      })
      throw RelayUnavailableError.make({
        code: "database_error",
        message: 'role "taken" already exists',
      })
    }
    if (outcome === "interrupted") {
      relay.journal.set(id, { status: "interrupted" })
      throw RelayUnavailableError.make({ message: "The Relay stopped" })
    }
    relay.journal.set(id, { result: {}, status: "succeeded" })
    if (outcome === "loses-reply") {
      throw RelayUnavailableError.make({ message: "The connection dropped" })
    }
    return {}
  },
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

afterAll(() => disposeAppRuntime())

const relayId = "relay-one"
const databaseId = "a".repeat(40)

const Lanes = testOperationsEngine(changeDatabaseLogin.layer).pipe(
  Layer.provideMerge(TestDatabase)
)

const seeded = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  relay.journal.clear()
  relay.next.length = 0
  relay.sent.length = 0
  relay.subjects.length = 0
  yield* createManagedDatabaseRecordEffect({
    createdBy: "user-one",
    databaseId,
    databaseName: "app",
    engine: "postgres",
    name: "App",
    password: "the-old-password",
    relayId,
    username: "old_user",
  })
})

const runToEnd = (change: { password?: string; username?: string }) =>
  Effect.gen(function* () {
    const id = yield* startDurableOperation(changeDatabaseLogin, {
      actorId: "user-one",
      databaseId,
      relayId,
      ...(change.username !== undefined && { username: change.username }),
      ...(change.password !== undefined && {
        passwordCiphertext: yield* encryptManagedDatabasePassword(
          change.password
        ),
      }),
    })
    return yield* loadOperation(id).pipe(
      Effect.repeat({
        schedule: Schedule.spaced("50 millis"),
        until: (record) =>
          record?.state === "succeeded" || record?.state === "failed",
      }),
      Effect.timeout("20 seconds")
    )
  })

const kept = loadManagedDatabaseCredentialEffect(relayId, databaseId).pipe(
  Effect.map((credential) => ({
    password: credential?.password,
    username: credential?.username,
  }))
)

describeMysql("changing a database's login", () => {
  layer(Lanes, { timeout: 60_000 })((it) => {
    it.effect(
      "keeps the new login, and no readable password with the operation",
      () =>
        Effect.gen(function* () {
          yield* seeded

          const done = yield* runToEnd({
            password: "the-new-password",
            username: "new_user",
          })

          assert.strictEqual(done?.state, "succeeded")
          assert.notInclude(JSON.stringify(done?.input), "the-new-password")
          assert.deepStrictEqual(relay.subjects, ["user-one"])
          assert.deepStrictEqual(relay.sent, [
            {
              currentPassword: "the-old-password",
              databaseId,
              nextPassword: "the-new-password",
              nextUsername: "new_user",
              username: "old_user",
            },
          ])
          assert.deepStrictEqual(yield* kept, {
            password: "the-new-password",
            username: "new_user",
          })
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "leaves out what isn't changing",
      () =>
        Effect.gen(function* () {
          yield* seeded

          yield* runToEnd({ username: "new_user" })

          assert.strictEqual(relay.sent[0]?.nextPassword, "the-old-password")
          assert.deepStrictEqual(yield* kept, {
            password: "the-old-password",
            username: "new_user",
          })
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "sends the same change again when the Relay stopped partway",
      () =>
        Effect.gen(function* () {
          yield* seeded
          relay.next.push("interrupted")

          const done = yield* runToEnd({
            password: "the-new-password",
            username: "new_user",
          })

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(relay.sent.length, 2)
          assert.deepStrictEqual(relay.sent[1], relay.sent[0])
          assert.deepStrictEqual(yield* kept, {
            password: "the-new-password",
            username: "new_user",
          })
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "keeps a change the Relay made whose reply never arrived",
      () =>
        Effect.gen(function* () {
          yield* seeded
          relay.next.push("loses-reply")

          const done = yield* runToEnd({ username: "new_user" })

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(relay.sent.length, 1)
          assert.strictEqual((yield* kept).username, "new_user")
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "keeps the old login when the Relay refuses",
      () =>
        Effect.gen(function* () {
          yield* seeded
          relay.next.push("refuses")

          const done = yield* runToEnd({ username: "taken" })

          assert.strictEqual(done?.state, "failed")
          assert.include(done?.error ?? "", "already exists")
          assert.strictEqual(relay.sent.length, 1)
          assert.deepStrictEqual(yield* kept, {
            password: "the-old-password",
            username: "old_user",
          })
        }).pipe(TestClock.withLive),
      30_000
    )
  })
})
