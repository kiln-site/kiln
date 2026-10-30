import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

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

        yield* Effect.flip(
          persistPairedRelayEffect({ ...pairedRelay, expectedExisting: true })
        )

        assert.deepEqual(yield* relayRows, unchanged("another-user"))
      })
    )

    it.effect("rejects pairing when committed Relay state changed", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* existingRelay("creator")

        yield* Effect.flip(persistPairedRelayEffect(pairedRelay))
        assert.deepEqual(yield* relayRows, unchanged("creator"))

        yield* resetDatabase
        yield* Effect.flip(
          persistPairedRelayEffect({ ...pairedRelay, expectedExisting: true })
        )
        assert.deepEqual(yield* relayRows, [])
      })
    )
  })
})
