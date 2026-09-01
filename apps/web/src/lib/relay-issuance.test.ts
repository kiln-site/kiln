import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { vi } from "vite-plus/test"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

import { Database } from "@/effect/database"
import { loadEnabledRelayForIssuanceEffect } from "@/lib/relay-registry"

describe("Relay capability issuance lookup", () => {
  it.effect("loads one enabled Relay and its encrypted signer by id", () => {
    let operation = ""
    let queryCount = 0
    let sql = ""
    let values: ReadonlyArray<unknown> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: <TRow extends RowDataPacket>(
        nextOperation: string,
        nextSql: string,
        nextValues?: Array<boolean | Buffer | Date | null | number | string>
      ) =>
        Effect.sync(() => {
          operation = nextOperation
          queryCount += 1
          sql = nextSql
          values = nextValues ?? []
          return [
            {
              browser_origin: "https://relay.example.com",
              client_actions: JSON.stringify(["relay.read"]),
              client_id: "client-one",
              client_private_key_ciphertext: "encrypted-private-key",
              client_public_key: "client-public-key",
              client_role: "full_access",
              created_at: new Date("2026-01-01T00:00:00.000Z"),
              created_by: "user-one",
              enabled: 1,
              hostname: "relay.example.com",
              id: "relay-one",
              last_connected_at: null,
              last_error: null,
              managed_ember_count: 2,
              name: "Relay One",
              node_arch: "arm64",
              node_platform: "linux",
              node_version: "24.0.0",
              port: 4100,
              relay_ca_certificate: "relay-ca",
              relay_public_key: "relay-public-key",
              use_tls: 1,
            },
          ] as unknown as ReadonlyArray<TRow>
        }),
      transaction: () => Effect.die("Unexpected transaction"),
    })

    return Effect.gen(function* () {
      const material = yield* loadEnabledRelayForIssuanceEffect("relay-one")

      assert.strictEqual(queryCount, 1)
      assert.strictEqual(operation, "relay_issuance")
      assert.include(sql, "WHERE id = ? AND enabled = TRUE")
      assert.deepEqual(values, ["relay-one"])
      assert.strictEqual(material.relay.id, "relay-one")
      assert.isTrue(material.relay.enabled)
      assert.strictEqual(
        material.encryptedCredentials.clientPrivateKeyCiphertext,
        "encrypted-private-key"
      )
      assert.strictEqual(
        material.encryptedCredentials.caCertificatePem,
        "relay-ca"
      )
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect("treats a missing or disabled Relay as unavailable", () => {
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: <TRow extends RowDataPacket>() =>
        Effect.succeed([] as unknown as ReadonlyArray<TRow>),
      transaction: () => Effect.die("Unexpected transaction"),
    })

    return Effect.gen(function* () {
      const result = yield* Effect.result(
        loadEnabledRelayForIssuanceEffect("disabled-relay")
      )

      assert.isTrue(Result.isFailure(result))
      if (Result.isFailure(result)) {
        assert.strictEqual(result.failure._tag, "ResourceNotFoundError")
      }
    }).pipe(Effect.provide(databaseLayer))
  })
})
