import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { loadResourceGrantsEffect } from "@/lib/resource-permissions"
import { persistPairedRelayEffect } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

const pairedRelay = {
  browserOrigin: "https://relay.example.com",
  clientActions: "[]",
  clientId: "client-id",
  clientPrivateKeyCiphertext: "new-ciphertext",
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

interface RelayRow {
  created_by: string | null
  client_private_key_ciphertext: string
  enabled: number
  issuer_generation: number
}

const relayRows = Effect.map(selectRows<RelayRow>("relay"), (rows) =>
  rows.map((row) => ({
    createdBy: row.created_by,
    ciphertext: row.client_private_key_ciphertext,
    enabled: Boolean(row.enabled),
    issuerGeneration: Number(row.issuer_generation),
  }))
)

const existingRelay = (createdBy: string) =>
  insertRelay("relay-id", {
    created_by: createdBy,
    client_private_key_ciphertext: "old-ciphertext",
    enabled: false,
    issuer_generation: 3,
  })

const unchanged = (createdBy: string) => [
  {
    createdBy,
    ciphertext: "old-ciphertext",
    enabled: false,
    issuerGeneration: 3,
  },
]

describeMysql("Relay pairing persistence", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "commits a new Relay whose creator holds authority without a grant row",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase

          yield* persistPairedRelayEffect(pairedRelay)

          assert.deepEqual(yield* relayRows, [
            {
              createdBy: "creator",
              ciphertext: "new-ciphertext",
              enabled: true,
              issuerGeneration: 1,
            },
          ])
          assert.deepEqual(yield* selectRows("access_grant"), [])
          const grants = yield* loadResourceGrantsEffect("creator", "relay-id")
          assert.deepEqual(
            grants.map((grant) => [grant.source, grant.resourceType]),
            [["owner", "relay"]]
          )
        })
    )

    it.effect("repairs a creator's Relay in place and rotates its issuer", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* existingRelay("creator")

        yield* persistPairedRelayEffect({
          ...pairedRelay,
          expectedExisting: true,
        })

        assert.deepEqual(yield* relayRows, [
          {
            createdBy: "creator",
            ciphertext: "new-ciphertext",
            enabled: true,
            issuerGeneration: 4,
          },
        ])
      })
    )

    it.effect("rejects a repair when committed ownership differs", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* existingRelay("another-user")

        const error = yield* Effect.flip(
          persistPairedRelayEffect({ ...pairedRelay, expectedExisting: true })
        )

        assert.strictEqual(
          error.message,
          "You can only manage Relays you created"
        )
        assert.deepEqual(yield* relayRows, unchanged("another-user"))
      })
    )

    it.effect("rejects pairing when committed Relay state changed", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* existingRelay("creator")

        const replaced = yield* Effect.flip(
          persistPairedRelayEffect(pairedRelay)
        )
        assert.strictEqual(
          replaced.message,
          "Relay pairing state changed. Try again."
        )
        assert.deepEqual(yield* relayRows, unchanged("creator"))

        yield* resetDatabase
        const vanished = yield* Effect.flip(
          persistPairedRelayEffect({ ...pairedRelay, expectedExisting: true })
        )
        assert.strictEqual(
          vanished.message,
          "Relay pairing state changed. Try again."
        )
        assert.deepEqual(yield* relayRows, [])
      })
    )
  })
})
