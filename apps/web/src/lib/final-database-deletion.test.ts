import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { deleteDatabaseWithoutFinalBackup } from "@/lib/final-database-deletion"
import type { PersistedRelay } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

afterAll(() => disposeAppRuntime())

// The Relay is the boundary: how its delete went.
const relay = vi.hoisted(() => ({
  deleted: [] as Array<{ databaseId: string; deleteData: boolean }>,
  failure: null as string | null,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { databaseId: string; deleteData: boolean }
  ) => {
    // The database's container is already gone.
    if (operation === "database.list") return []
    if (operation !== "database.delete") {
      throw new Error(`Unexpected Relay operation ${operation}`)
    }
    if (relay.failure) throw new Error(relay.failure)
    relay.deleted.push(payload)
    return { databaseId: payload.databaseId, deleted: true }
  },
}))

const relayId = "r".repeat(43)
const databaseId = "d".repeat(40)
const persisted = { id: relayId, name: "Relay" } as PersistedRelay

const insertDatabase = insertRows("database", {
  created_at: 0,
  created_by: "user-one",
  database_id: databaseId,
  database_name: "kiln_main",
  engine: "postgres",
  name: "Main",
  password_ciphertext: "ciphertext",
  relay_id: relayId,
  updated_at: 0,
  username: "kiln_user",
})

const records = selectRows("database")

describeMysql("database deletion on the Relay", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps the record when the Relay couldn't remove everything", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId)
        yield* insertDatabase
        relay.failure = "network has active endpoints"

        const failed = yield* Effect.flip(
          Effect.tryPromise({
            try: () =>
              deleteDatabaseWithoutFinalBackup({
                databaseId,
                relay: persisted,
                requestedBy: "user-one",
              }),
            catch: (cause) => cause,
          })
        )

        assert.match(String(failed), /network has active endpoints/u)
        assert.lengthOf(yield* records, 1)
      })
    )

    it.effect("removes the record once the Relay has nothing of it left", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId)
        yield* insertDatabase
        relay.failure = "Database not found"

        yield* Effect.promise(() =>
          deleteDatabaseWithoutFinalBackup({
            databaseId,
            relay: persisted,
            requestedBy: "user-one",
          })
        )

        assert.lengthOf(yield* records, 0)
      })
    )
  })
})
