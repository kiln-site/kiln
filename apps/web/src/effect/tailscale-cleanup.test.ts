import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader } from "mysql2/promise"

import { Database } from "@/effect/database"

import {
  completeTailscaleCleanupEffect,
  loadPendingTailscaleCleanupsEffect,
  reconcileTailscaleDeploymentsEffect,
  requestTailscaleNetworkCleanupEffect,
  tailscaleCleanupRetryDelaySeconds,
} from "./tailscale-cleanup"

const emptyResult: ResultSetHeader = {
  affectedRows: 1,
  changedRows: 1,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const statements: Array<{
  sql: string
  values: ReadonlyArray<unknown>
}> = []
let pendingRows: Array<Record<string, unknown>> = []

const databaseLayer = Layer.succeed(Database)({
  execute: () => Effect.die("Unexpected standalone database write"),
  queryRows: <TRow>() =>
    Effect.succeed(pendingRows as unknown as ReadonlyArray<TRow>),
  transaction: (_operation, run) =>
    run({
      execute: (sql, values) =>
        Effect.sync(() => {
          statements.push({ sql, values: values ?? [] })
          return emptyResult
        }),
      queryRows: () => Effect.die("Unexpected transaction query"),
    }),
})

describe("Tailscale cleanup retries", () => {
  it("backs off quickly and caps retries at five minutes", () => {
    assert.deepEqual(
      [1, 2, 3, 8, 9, 20].map(tailscaleCleanupRetryDelaySeconds),
      [2, 4, 8, 256, 300, 300]
    )
  })

  it.effect("keeps previously observed offline Relays queued", () =>
    Effect.gen(function* () {
      statements.length = 0

      yield* requestTailscaleNetworkCleanupEffect(
        "a".repeat(40),
        "user-one",
        []
      )

      assert.strictEqual(statements.length, 1)
      assert.include(statements[0]?.sql, "deletion_requested_at")
      assert.notInclude(statements[0]?.sql, "DELETE")
      assert.deepEqual(statements[0]?.values, ["user-one", "a".repeat(40)])
    }).pipe(Effect.provide(databaseLayer))
  )

  it.effect("only removes Relay snapshots explicitly removed by the save", () =>
    Effect.gen(function* () {
      statements.length = 0
      const networkId = "a".repeat(40)
      const removedRelayId = "b".repeat(43)

      yield* reconcileTailscaleDeploymentsEffect(networkId, [], [])
      assert.strictEqual(statements.length, 0)

      yield* reconcileTailscaleDeploymentsEffect(
        networkId,
        [],
        [removedRelayId]
      )
      assert.strictEqual(statements.length, 1)
      assert.include(statements[0]?.sql, "relay_id IN (?)")
      assert.notInclude(statements[0]?.sql, "NOT IN")
      assert.deepEqual(statements[0]?.values, [networkId, removedRelayId])
    }).pipe(Effect.provide(databaseLayer))
  )

  it.effect("defers corrupt rows without blocking valid cleanup jobs", () =>
    Effect.gen(function* () {
      statements.length = 0
      const networkId = "a".repeat(40)
      const corruptRelayId = "b".repeat(43)
      const validRelayId = "c".repeat(43)
      pendingRows = [
        {
          cleanup_attempts: 2,
          cleanup_last_error: null,
          deployment: "{not json",
          network_id: networkId,
          relay_id: corruptRelayId,
          requested_by: "user-one",
        },
        {
          cleanup_attempts: 0,
          cleanup_last_error: null,
          deployment: JSON.stringify(
            persistedDeployment(networkId, validRelayId)
          ),
          network_id: networkId,
          relay_id: validRelayId,
          requested_by: "user-one",
        },
      ]

      const batch = yield* loadPendingTailscaleCleanupsEffect()

      assert.strictEqual(batch.cleanups.length, 1)
      assert.strictEqual(batch.cleanups[0]?.deployment.relayId, validRelayId)
      assert.strictEqual(batch.deferredCorruptRows, 1)
      assert.strictEqual(statements.length, 2)
      assert.include(
        String(statements[0]?.values[2]),
        "Stored Tailscale cleanup data is invalid"
      )
      pendingRows = []
    }).pipe(Effect.provide(databaseLayer))
  )

  it.effect(
    "clears Relay retry state after completing the last deployment",
    () =>
      Effect.gen(function* () {
        statements.length = 0
        const networkId = "a".repeat(40)
        const relayId = "b".repeat(43)

        yield* completeTailscaleCleanupEffect(networkId, relayId)

        assert.strictEqual(statements.length, 2)
        assert.include(statements[0]?.sql, "DELETE FROM")
        assert.deepEqual(statements[0]?.values, [networkId, relayId])
        assert.include(statements[1]?.sql, "cleanup_next_attempt_at")
        assert.include(statements[1]?.sql, "cleanup_attempts = 0")
        assert.include(statements[1]?.sql, "CURRENT_TIMESTAMP(3)")
        assert.include(statements[1]?.sql, "cleanup_last_error = NULL")
        assert.include(statements[1]?.sql, "NOT EXISTS")
        assert.deepEqual(statements[1]?.values, [networkId])
      }).pipe(Effect.provide(databaseLayer))
  )
})

function persistedDeployment(networkId: string, relayId: string) {
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
