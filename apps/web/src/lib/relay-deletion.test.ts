import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import * as TestClock from "effect/testing/TestClock"

import { deletePersistedRelayEffect } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

const invitation = (
  id: string,
  relayId: string,
  acceptedAt: number | null
) => ({
  id,
  token_hash: id.padEnd(64, "0"),
  email: `${id}@example.test`,
  relay_id: relayId,
  invited_by: "admin",
  expires_at: 10_000,
  accepted_at: acceptedAt,
  created_at: 0,
})

const network = (id: string) => ({
  id: id.padEnd(40, "0"),
  name: id,
  domain: `${id}.ts.net`,
  deletion_requested_at: 1,
  cleanup_attempts: 5,
  cleanup_next_attempt_at: 99_999,
  cleanup_last_error: "Relay unreachable",
  created_at: 0,
  updated_at: 0,
})

const deployment = (networkId: string, relayId: string) => ({
  network_id: networkId.padEnd(40, "0"),
  relay_id: relayId,
  deployment: "{}",
  cleanup_next_attempt_at: 0,
  observed_at: 0,
  updated_at: 0,
})

describeMysql("Relay deletion", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "revokes pending access, releases network cleanup, and removes only that Relay",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay-one")
          yield* insertRelay("relay-two")
          yield* insertInstance("relay-one", "instance-one")
          yield* insertRows("invitation", [
            invitation("pending", "relay-one", null),
            invitation("accepted", "relay-one", 5),
            invitation("elsewhere", "relay-two", null),
          ])
          yield* insertGrant({
            userId: "user",
            relayId: "relay-one",
            resourceType: "instance",
            resourceId: "instance-one",
          })
          yield* insertGrant({
            userId: "user",
            relayId: "relay-two",
            resourceType: "relay",
            resourceId: "relay-two",
          })
          // A deleting network held only by this Relay can finish cleanup; one
          // still deployed elsewhere keeps waiting on that Relay.
          yield* insertRows("tailscale_network", [
            network("solo"),
            network("shared"),
          ])
          yield* insertRows("tailscale_network_deployment", [
            deployment("solo", "relay-one"),
            deployment("shared", "relay-one"),
            deployment("shared", "relay-two"),
          ])

          yield* TestClock.setTime(1_000)
          yield* deletePersistedRelayEffect("relay-one")

          const relays = yield* selectRows<{ id: string }>("relay")
          assert.deepEqual(
            relays.map((row) => row.id),
            ["relay-two"]
          )
          assert.deepEqual(yield* selectRows("instance"), [])
          const grants = yield* selectRows<{ relay_id: string }>("access_grant")
          assert.deepEqual(
            grants.map((row) => row.relay_id),
            ["relay-two"]
          )
          const invitations = yield* selectRows<{
            id: string
            revoked_at: number | null
          }>("invitation")
          assert.deepEqual(
            Object.fromEntries(
              invitations.map((row) => [
                row.id,
                row.revoked_at === null ? null : Number(row.revoked_at),
              ])
            ),
            { accepted: null, elsewhere: null, pending: 1_000 }
          )
          const networks = yield* selectRows<{
            name: string
            cleanup_attempts: number
            cleanup_next_attempt_at: number
            cleanup_last_error: string | null
          }>("tailscale_network")
          assert.deepEqual(
            Object.fromEntries(
              networks.map((row) => [
                row.name,
                [
                  row.cleanup_attempts,
                  Number(row.cleanup_next_attempt_at),
                  row.cleanup_last_error,
                ],
              ])
            ),
            {
              shared: [5, 99_999, "Relay unreachable"],
              solo: [0, 1_000, null],
            }
          )
          const deployments = yield* selectRows<{ relay_id: string }>(
            "tailscale_network_deployment"
          )
          assert.deepEqual(
            deployments.map((row) => row.relay_id),
            ["relay-two"]
          )
        })
    )

    it.effect("changes nothing when the Relay is already gone", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRows(
          "invitation",
          invitation("pending", "relay-one", null)
        )
        yield* insertGrant({
          userId: "user",
          relayId: "relay-one",
          resourceType: "relay",
          resourceId: "relay-one",
        })

        const error = yield* Effect.flip(
          deletePersistedRelayEffect("relay-one")
        )

        assert.strictEqual(error.message, "Relay not found")
        const invitations = yield* selectRows<{ revoked_at: number | null }>(
          "invitation"
        )
        assert.deepEqual(
          invitations.map((row) => row.revoked_at),
          [null]
        )
        assert.lengthOf(yield* selectRows("access_grant"), 1)
      })
    )
  })
})
