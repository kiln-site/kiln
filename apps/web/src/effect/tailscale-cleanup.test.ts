import { assert, describe, it, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  completeTailscaleCleanupEffect,
  loadPendingTailscaleCleanupsEffect,
  reconcileTailscaleDeploymentsEffect,
  requestTailscaleNetworkCleanupEffect,
  tailscaleCleanupRetryDelaySeconds,
} from "@/effect/tailscale-cleanup"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

const now = 1_700_000_000_000
const networkId = "a".repeat(40)
const relayB = "b".repeat(43)
const relayC = "c".repeat(43)

interface NetworkRow {
  cleanup_attempts: number
  cleanup_last_error: string | null
  cleanup_next_attempt_at: number | null
  deletion_requested_at: number | null
  deletion_requested_by: string | null
}

interface DeploymentRow {
  cleanup_attempts: number
  cleanup_last_error: string | null
  cleanup_next_attempt_at: number
  relay_id: string
}

const insertNetwork = (row: Record<string, string | number | null> = {}) =>
  insertRows("tailscale_network", {
    id: networkId,
    name: "Private Network",
    domain: "private.test",
    created_at: now - 60_000,
    updated_at: now - 60_000,
    ...row,
  })

const insertDeployment = (
  relayId: string,
  row: Record<string, string | number | null> = {}
) =>
  insertRows("tailscale_network_deployment", {
    network_id: networkId,
    relay_id: relayId,
    deployment: JSON.stringify(persistedDeployment(relayId)),
    cleanup_next_attempt_at: now - 1_000,
    observed_at: now - 60_000,
    updated_at: now - 60_000,
    ...row,
  })

const network = Effect.map(
  selectRows<NetworkRow>("tailscale_network"),
  (rows) => rows[0]
)

const deployments = Effect.map(
  selectRows<DeploymentRow>("tailscale_network_deployment"),
  (rows) => new Map(rows.map((row) => [row.relay_id, row]))
)

describe("Tailscale cleanup retries", () => {
  it("backs off quickly and caps retries at five minutes", () => {
    assert.deepEqual(
      [1, 2, 3, 8, 9, 20].map(tailscaleCleanupRetryDelaySeconds),
      [2, 4, 8, 256, 300, 300]
    )
  })
})

describeMysql("Tailscale cleanup persistence", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "queues previously observed Relays and keeps the first request",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* TestClock.setTime(now)
          yield* insertNetwork({
            cleanup_attempts: 4,
            cleanup_last_error: "old",
          })
          yield* insertDeployment(relayB)

          yield* requestTailscaleNetworkCleanupEffect(networkId, "user-one", [])
          yield* TestClock.adjust(5_000)
          yield* requestTailscaleNetworkCleanupEffect(networkId, "user-two", [])

          const requested = yield* network
          assert.strictEqual(Number(requested?.deletion_requested_at), now)
          assert.strictEqual(requested?.deletion_requested_by, "user-one")
          assert.strictEqual(requested?.cleanup_attempts, 0)
          assert.strictEqual(
            Number(requested?.cleanup_next_attempt_at),
            now + 5_000
          )
          assert.isNull(requested?.cleanup_last_error)

          const batch = yield* loadPendingTailscaleCleanupsEffect()
          assert.deepStrictEqual(
            batch.cleanups.map((cleanup) => [
              cleanup.deployment.relayId,
              cleanup.requestedBy,
            ]),
            [[relayB, "user-one"]]
          )
        })
    )

    it.effect(
      "only removes Relay snapshots explicitly removed by the save",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* TestClock.setTime(now)
          yield* insertNetwork()
          yield* insertDeployment(relayB)
          yield* insertDeployment(relayC)

          yield* reconcileTailscaleDeploymentsEffect(networkId, [], [])
          assert.sameMembers([...(yield* deployments).keys()], [relayB, relayC])

          yield* reconcileTailscaleDeploymentsEffect(networkId, [], [relayB])
          assert.sameMembers([...(yield* deployments).keys()], [relayC])
        })
    )

    it.effect("defers corrupt rows without blocking valid cleanup jobs", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* TestClock.setTime(now)
        yield* insertNetwork({
          deletion_requested_at: now - 60_000,
          deletion_requested_by: "user-one",
        })
        yield* insertDeployment(relayB, {
          cleanup_attempts: 2,
          deployment: JSON.stringify({ not: "a deployment" }),
        })
        yield* insertDeployment(relayC)

        const batch = yield* loadPendingTailscaleCleanupsEffect()

        assert.deepStrictEqual(
          batch.cleanups.map((cleanup) => cleanup.deployment.relayId),
          [relayC]
        )
        assert.strictEqual(batch.deferredCorruptRows, 1)
        const corrupt = (yield* deployments).get(relayB)
        assert.strictEqual(corrupt?.cleanup_attempts, 3)
        // Attempt 3 backs off 8 seconds from the current clock.
        assert.strictEqual(
          Number(corrupt?.cleanup_next_attempt_at),
          now + 8_000
        )
        assert.isNotNull(corrupt?.cleanup_last_error)

        const retried = yield* loadPendingTailscaleCleanupsEffect()
        assert.deepStrictEqual(
          retried.cleanups.map((cleanup) => cleanup.deployment.relayId),
          [relayC]
        )
        assert.strictEqual(retried.deferredCorruptRows, 0)
      })
    )

    it.effect(
      "clears network retry state after the last deployment completes",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* TestClock.setTime(now)
          yield* insertNetwork({
            cleanup_attempts: 3,
            cleanup_last_error: "Relay offline",
            cleanup_next_attempt_at: now + 60_000,
            deletion_requested_at: now - 60_000,
            deletion_requested_by: "user-one",
          })
          yield* insertDeployment(relayB)
          yield* insertDeployment(relayC)

          yield* completeTailscaleCleanupEffect(networkId, relayB)

          assert.sameMembers([...(yield* deployments).keys()], [relayC])
          assert.strictEqual((yield* network)?.cleanup_attempts, 3)

          yield* completeTailscaleCleanupEffect(networkId, relayC)

          assert.strictEqual((yield* deployments).size, 0)
          const cleared = yield* network
          assert.strictEqual(cleared?.cleanup_attempts, 0)
          assert.isNull(cleared?.cleanup_last_error)
          assert.strictEqual(Number(cleared?.cleanup_next_attempt_at), now)
        })
    )
  })
})

function persistedDeployment(relayId: string) {
  return {
    bindings: [],
    components: {
      coreDnsRunning: false,
      tailscaleRunning: false,
    },
    domain: "test",
    hostname: "private-network",
    id: networkId,
    instance: {
      brickId: "tailscale",
      connectAddress: "private-network.test",
      containerId: "docker-container-id",
      desiredState: "stopped",
      directory: networkId,
      game: "Networking",
      id: networkId,
      implementation: "Tailscale",
      javaVersion: "Tailscale + CoreDNS",
      managedByRelay: true,
      name: "Private Network",
      observedState: "stopped",
      service: "kiln-ts-aaaaaaaa",
      shortId: networkId.slice(0, 8),
      startedAt: null,
      status: "Exited (0)",
      version: "stable",
    },
    name: "Private Network",
    relayId,
    relayName: "Relay One",
    status: {
      connected: false,
      ipv4Address: null,
      ipv6Address: null,
      message: "Tailscale is stopped",
    },
    subnet: "10.165.55.0/24",
  }
}
