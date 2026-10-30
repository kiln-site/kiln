import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"

import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  cancelServerMigrationEffect,
  resumeServerMigrationsEffect,
} from "@/lib/server-migrations.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

// The Relays are the only fake: the old server sits stopped on its Relay,
// and every action asked of a Relay is recorded.
const relayCalls = vi.hoisted(() => [] as Array<string>)
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string, payload: unknown) => {
    if (operation === "relay.snapshot") return relaySnapshot()
    // The old server's routes already moved, before its worker stopped.
    if (operation === "instance.network.routes.read") {
      return {
        edgeConnected: true,
        message: "Ready",
        proxyConnected: true,
        requiresRestart: false,
        routes: [],
        status: "ready",
      }
    }
    relayCalls.push(
      `${operation}:${(payload as { action?: string }).action ?? ""}`
    )
    return {}
  },
}))

afterAll(() => disposeAppRuntime())

const at = 1_767_225_600_000
const sourceRelayId = "relay-old"
const destinationRelayId = "relay-new"
const sourceId = "a1".repeat(20)
const copyId = "b2".repeat(20)

const user = {
  id: "mover",
  email: "mover@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  name: "Mover",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

// A move told to delete its old server, at its last step, whose worker
// stopped: one ending it as failed, or still handing things over.
const seedMove = (input: {
  deleteSource: boolean
  deletion: "backing_up" | "failed" | null
  ending: boolean
  // Whether its worker stopped, so the next pass takes it over.
  stopped?: boolean
}) =>
  Effect.gen(function* () {
    yield* resetDatabase
    relayCalls.length = 0
    yield* insertUser(user.id, { emailVerifiedAt: new Date(at) })
    yield* insertRelay(sourceRelayId)
    yield* insertRelay(destinationRelayId)
    if (input.deletion) {
      yield* insertBackup("final-backup", {
        relay_id: sourceRelayId,
        target_id: sourceId,
        reason: "final_delete",
        status: input.deletion === "failed" ? "failed" : "running",
      })
      yield* insertRows("backup_task", {
        id: "final-backup-task",
        backup_id: "final-backup",
        task_kind: "create",
        status: input.deletion === "failed" ? "failed" : "running",
        created_at: at,
        updated_at: at,
      })
      yield* insertRows("resource_deletion", {
        id: randomUUID(),
        relay_id: sourceRelayId,
        resource_kind: "instance",
        resource_id: sourceId,
        final_backup: true,
        backup_id: "final-backup",
        status: input.deletion,
        requested_by: user.id,
        actor: JSON.stringify(user),
        created_at: at,
        updated_at: at,
      })
    }
    const id = randomUUID()
    yield* insertRows("server_migration", {
      actor: JSON.stringify(user),
      claim_generation: 1,
      create_key: randomUUID(),
      created_at: at,
      destination_created: 1,
      destination_instance_id: copyId,
      destination_name: "Survival",
      destination_relay_id: destinationRelayId,
      error: input.ending ? "Relay connection closed" : null,
      finished_parts: JSON.stringify([]),
      id,
      lease_until: input.ending || input.stopped ? 0 : at * 2,
      mode: "migrate",
      options: JSON.stringify({
        backup: null,
        copyAccess: false,
        deleteSource: input.deleteSource ? {} : null,
        keepActivity: false,
        moveDomain: false,
        moveWebRoutes: false,
        stopSource: true,
      }),
      requested_by: user.id,
      source_instance_id: sourceId,
      source_name: "Survival",
      source_relay_id: sourceRelayId,
      source_was_running: 1,
      state: input.ending ? "cancelling" : "running",
      step: "finish",
      updated_at: at,
    })
    return id
  })

// Takes the stopped worker's place and waits for the move to end.
const resumeUntilEnded = (id: string) =>
  Effect.gen(function* () {
    yield* resumeServerMigrationsEffect()
    yield* Effect.promise(() =>
      vi.waitFor(
        async () => {
          const [row] = await Effect.runPromise(
            migrationRows.pipe(
              Effect.map((rows) => rows.filter((item) => item.id === id)),
              Effect.provide(TestDatabase)
            )
          )
          if (row?.state === "running" || row?.state === "cancelling") {
            throw new Error("Still running")
          }
        },
        { timeout: 5_000 }
      )
    )
    const [row] = (yield* migrationRows).filter((item) => item.id === id)
    return row
  })

const migrationRows = selectRows<{
  error: string | null
  id: string
  state: string
}>("server_migration")

describeMysql("Server migration deleting its old server", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "finishes a move that already asked for its old server's deletion, and leaves that server stopped",
      () =>
        Effect.gen(function* () {
          const id = yield* seedMove({
            deleteSource: true,
            deletion: "backing_up",
            ending: true,
          })

          const row = yield* resumeUntilEnded(id)

          assert.strictEqual(row?.state, "completed")
          assert.strictEqual(row?.error, null)
          assert.notInclude(relayCalls, "instance.action:start")
        })
    )

    it.effect(
      "hands its old server to deletion, with a final backup, as its last part",
      () =>
        Effect.gen(function* () {
          const id = yield* seedMove({
            deleteSource: true,
            deletion: null,
            ending: false,
            stopped: true,
          })

          const row = yield* resumeUntilEnded(id)

          assert.strictEqual(row?.state, "completed")
          const deletions = yield* selectRows<{
            final_backup: number
            requested_by: string
            resource_id: string
            resource_kind: string
          }>("resource_deletion")
          assert.deepStrictEqual(
            deletions.map((deletion) => ({
              final_backup: Number(deletion.final_backup),
              requested_by: deletion.requested_by,
              resource_id: deletion.resource_id,
              resource_kind: deletion.resource_kind,
            })),
            [
              {
                final_backup: 1,
                requested_by: user.id,
                resource_id: sourceId,
                resource_kind: "instance",
              },
            ]
          )
          // The mover holds no grant on it here, so its deletion stops
          // before it touches the old server.
          yield* Effect.promise(() =>
            vi.waitFor(
              async () => {
                const [deletion] = await Effect.runPromise(
                  selectRows<{ status: string }>("resource_deletion").pipe(
                    Effect.provide(TestDatabase)
                  )
                )
                if (deletion?.status !== "failed") throw new Error("Running")
              },
              { timeout: 30_000 }
            )
          )
          assert.notInclude(relayCalls, "resource.freeze:")
        })
    )

    it.effect(
      "won't cancel a move handing over to deleting its old server",
      () =>
        Effect.gen(function* () {
          const deleting = yield* seedMove({
            deleteSource: true,
            deletion: null,
            ending: false,
          })

          const refused = yield* cancelServerMigrationEffect(
            user.id,
            deleting
          ).pipe(Effect.flip)

          assert.match(refused.message, /can't be cancelled/)
          assert.strictEqual(
            (yield* migrationRows).find((row) => row.id === deleting)?.state,
            "running"
          )

          const keeping = yield* seedMove({
            deleteSource: false,
            deletion: null,
            ending: false,
          })
          yield* cancelServerMigrationEffect(user.id, keeping)
          assert.strictEqual(
            (yield* migrationRows).find((row) => row.id === keeping)?.state,
            "cancelling"
          )
        })
    )
  })
})

function relaySnapshot() {
  return {
    instances: [
      {
        id: sourceId,
        shortId: sourceId.slice(0, 8),
        name: "Survival",
        service: "survival",
        directory: "/data/survival",
        containerId: null,
        desiredState: "stopped",
        observedState: "stopped",
        status: "stopped",
        game: "Minecraft",
        implementation: "paper",
        javaVersion: "21",
        version: "1.21",
        connectAddress: "play.example.test:25565",
      },
    ],
    node: {
      id: sourceRelayId,
      name: "Old",
      version: "test",
      platform: "linux",
      arch: "arm64",
      connectedAt: "2026-01-01T00:00:00.000Z",
      cpu: { cores: 4, loadPercent: 0 },
      memory: { totalBytes: 1, usedBytes: 0 },
      storage: { totalBytes: 1, usedBytes: 0 },
      docker: { available: true, version: "test" },
    },
  }
}
