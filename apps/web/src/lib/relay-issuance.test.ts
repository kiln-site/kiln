import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { loadEnabledRelayForIssuanceEffect } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

describeMysql("Relay capability issuance lookup", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "loads the requested enabled Relay and its encrypted signer",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one", {
            client_private_key_ciphertext: "encrypted-private-key",
            relay_ca_certificate: "relay-ca",
            created_by: "user-one",
          })
          yield* insertRelay("relay-two", {
            client_private_key_ciphertext: "other-private-key",
          })

          const material = yield* loadEnabledRelayForIssuanceEffect("relay-one")

          assert.strictEqual(material.relay.id, "relay-one")
          assert.isTrue(material.relay.enabled)
          assert.deepEqual(material.encryptedCredentials, {
            caCertificatePem: "relay-ca",
            clientId: "client-relay-one",
            clientPrivateKeyCiphertext: "encrypted-private-key",
            clientPublicKeyPem: "client-public-key",
            relayId: "relay-one",
            relayPublicKeyPem: "relay-public-key",
          })
        })
    )

    it.effect("treats a missing or paused Relay as unavailable", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("paused-relay", { enabled: false })

        for (const id of ["paused-relay", "missing-relay"]) {
          const error = yield* Effect.flip(
            loadEnabledRelayForIssuanceEffect(id)
          )
          assert.strictEqual(error._tag, "ResourceNotFoundError")
        }
      })
    )
  })
})
