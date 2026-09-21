import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { vi } from "vite-plus/test"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import { Database } from "@/effect/database"
import { persistPairedRelayEffect } from "@/lib/relay-registry"

const emptyResult: ResultSetHeader = {
  affectedRows: 1,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const pairedRelay = {
  browserOrigin: "https://relay.example.com",
  clientActions: "[]",
  clientId: "client-id",
  clientPrivateKeyCiphertext: "ciphertext",
  clientPublicKey: "client-public-key",
  clientRole: "full_access" as const,
  createdBy: "creator",
  creatorUserId: "creator",
  expectedExisting: false,
  hostname: "relay.example.com",
  id: "relay-id",
  name: "Relay",
  port: 443,
  relayCaCertificate: null,
  relayPublicKey: "relay-public-key",
  useTls: true,
}

describe("Relay pairing persistence", () => {
  it.effect("commits a new Relay without a separate owner grant", () => {
    const writes: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    const databaseLayer = pairingDatabaseLayer({
      persistedRows: [],
      writes,
    })

    return Effect.gen(function* () {
      yield* persistPairedRelayEffect(pairedRelay)

      // Creator authority derives from relay.created_by; no empty grant row.
      assert.strictEqual(writes.length, 1)
      assert.match(writes[0]?.sql ?? "", /INSERT INTO .*kiln_relay/u)
      assert.notMatch(writes[0]?.sql ?? "", /kiln_access_grant/u)
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect("repairs a creator Relay in place", () => {
    const writes: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    const databaseLayer = pairingDatabaseLayer({
      persistedRows: [{ created_by: "creator" }],
      writes,
    })

    return Effect.gen(function* () {
      yield* persistPairedRelayEffect({
        ...pairedRelay,
        expectedExisting: true,
      })

      assert.strictEqual(writes.length, 1)
      assert.match(writes[0]?.sql ?? "", /UPDATE .*kiln_relay/u)
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect("rejects a creator repair when committed ownership differs", () => {
    const writes: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    const databaseLayer = pairingDatabaseLayer({
      persistedRows: [{ created_by: "another-user" }],
      writes,
    })

    return Effect.gen(function* () {
      const error = yield* persistPairedRelayEffect({
        ...pairedRelay,
        expectedExisting: true,
      }).pipe(Effect.flip)

      assert.strictEqual(
        error.message,
        "You can only manage Relays you created"
      )
      assert.strictEqual(writes.length, 0)
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect("rejects pairing when committed Relay state changed", () => {
    const writes: Array<{ sql: string; values: ReadonlyArray<unknown> }> = []
    const databaseLayer = pairingDatabaseLayer({
      persistedRows: [{ created_by: "creator" }],
      writes,
    })

    return Effect.gen(function* () {
      const error = yield* persistPairedRelayEffect(pairedRelay).pipe(
        Effect.flip
      )

      assert.strictEqual(
        error.message,
        "Relay pairing state changed. Try again."
      )
      assert.strictEqual(writes.length, 0)
    }).pipe(Effect.provide(databaseLayer))
  })
})

function pairingDatabaseLayer(input: {
  persistedRows: ReadonlyArray<{ created_by: string | null }>
  writes: Array<{ sql: string; values: ReadonlyArray<unknown> }>
}) {
  return Layer.succeed(Database)({
    execute: () => Effect.die("Unexpected standalone database write"),
    queryRows: () => Effect.die("Unexpected standalone database query"),
    transaction: (_operation, run) =>
      run({
        execute: (sql, values) =>
          Effect.sync(() => {
            input.writes.push({ sql, values: values ?? [] })
            return emptyResult
          }),
        queryRows: <TRow extends RowDataPacket>() =>
          Effect.succeed(input.persistedRows as unknown as ReadonlyArray<TRow>),
      }),
  })
}
