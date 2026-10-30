import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { AppCache } from "@/effect/cache"
import { disposeAppRuntime } from "@/effect/runtime"
import { cleanUpDeletedResourceEffect } from "@/server/resource-deletion-cleanup"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, selectRows } from "@/test/seed"

afterAll(() => disposeAppRuntime())

// Relays are the boundary: what schedules were sent to them, and which ones
// were woken to fetch new authorization.
const relays = vi.hoisted(() => ({
  applied: [] as Array<{ id: string; relayId: string; revision: number }>,
  removed: [] as Array<{ relayId: string; scheduleId: string }>,
  woken: [] as Array<string>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    relay: { id: string },
    operation: string,
    payload: {
      generation?: number
      id?: string
      revision: number
      scheduleId?: string
    }
  ) => {
    if (operation === "schedule.apply") {
      relays.applied.push({
        id: payload.id ?? "",
        relayId: relay.id,
        revision: payload.revision,
      })
      return {
        acknowledgedGeneration: payload.generation,
        acknowledgedRevision: payload.revision,
        nextRunAt: null,
        scheduleId: payload.id,
      }
    }
    if (operation === "schedule.remove") {
      relays.removed.push({
        relayId: relay.id,
        scheduleId: payload.scheduleId ?? "",
      })
      return { removed: true, revision: payload.revision }
    }
    throw new Error(`Unexpected Relay operation ${operation}`)
  },
}))
vi.mock("@/lib/authorization-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization-delivery")>()),
  wakeAuthorizationDelivery: (relayId: string) => {
    relays.woken.push(relayId)
  },
}))

const relayId = "r".repeat(43)
const otherRelayId = "s".repeat(43)
const databaseId = "d".repeat(40)
const otherDatabaseId = "e".repeat(40)
const now = 1_700_000_000_000
const sharedSchedule = "11111111-1111-4111-8111-111111111111"
const aloneSchedule = "22222222-2222-4222-8222-222222222222"
const crossRelaySchedule = "33333333-3333-4333-8333-333333333333"
const remoteDatabaseId = "f".repeat(40)
const keyOf = (relay: string, id: string) => `${relay}:database:${id}`

const disabledCache = Layer.succeed(AppCache)({
  backend: "disabled",
  enabled: false,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
})

const insertDatabase = (id: string, name: string) =>
  insertRows("database", {
    created_at: now,
    created_by: "user-one",
    database_id: id,
    database_name: `db_${name}`,
    engine: "postgres",
    name,
    password_ciphertext: "ciphertext",
    relay_id: relayId,
    updated_at: now,
    username: `user_${name}`,
  })

const insertFavorite = (userId: string, kind: string, id: string) =>
  insertRows("instance_favorite", {
    created_at: now,
    relay_id: relayId,
    resource_id: id,
    resource_kind: kind,
    user_id: userId,
  })

const insertIcon = (kind: string, id: string) =>
  insertRows("icon", {
    checked_at: now,
    relay_id: relayId,
    source: "custom",
    subject_id: id,
    subject_kind: kind,
    updated_at: now,
  })

const insertSchedule = (
  id: string,
  targets: ReadonlyArray<{
    id: string
    kind?: string
    relayId: string
    name: string
  }>,
  actions: ReadonlyArray<Record<string, unknown>> = [
    { duration: 5, type: "wait", unit: "seconds" },
  ]
) =>
  Effect.gen(function* () {
    yield* insertRows("schedule", {
      created_at: now,
      created_by: "user-one",
      cron_expression: "0 3 * * *",
      enabled: true,
      id,
      name: id,
      revision: 4,
      timezone: "UTC",
      updated_at: now,
    })
    for (const [position, action] of actions.entries()) {
      const actionId = id.replace(/^./u, String.fromCharCode(97 + position))
      yield* insertRows("schedule_action", {
        action_config: JSON.stringify({ ...action, id: actionId }),
        action_type: String(action.type),
        created_at: now,
        id: actionId,
        position,
        schedule_id: id,
      })
    }
    for (const target of targets) {
      yield* insertRows("schedule_target", {
        created_at: now,
        relay_id: target.relayId,
        schedule_id: id,
        target_id: target.id,
        target_kind: target.kind ?? "database",
        target_name: target.name,
      })
      yield* insertRows("schedule_deployment", {
        acknowledged_revision: 4,
        created_at: now,
        desired_revision: 4,
        relay_id: target.relayId,
        schedule_id: id,
        status: "applied",
        updated_at: now,
      }).pipe(Effect.ignore)
    }
  })

const byKey = (left: ReadonlyArray<unknown>, right: ReadonlyArray<unknown>) =>
  String(left).localeCompare(String(right))

const ids = <T extends Record<string, unknown>>(
  rows: ReadonlyArray<T>,
  key: keyof T
) => rows.map((row) => row[key])

describeMysql("cleaning up after a deleted resource", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "takes a database's access, favorites, schedules, and record, and tells Relays",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relays.woken.length = 0
          yield* insertRelay(relayId)
          yield* insertDatabase(databaseId, "main")
          yield* insertDatabase(otherDatabaseId, "other")
          yield* insertGrant({
            id: "grant-deleted",
            relayId,
            resourceId: databaseId,
            resourceType: "database",
            userId: "user-one",
          })
          yield* insertGrant({
            id: "grant-other",
            relayId,
            resourceId: otherDatabaseId,
            resourceType: "database",
            userId: "user-two",
          })
          yield* insertRows("invitation", {
            created_at: now,
            database_id: databaseId,
            email: "pending@example.test",
            expires_at: Date.now() + 60_000,
            id: "pending",
            invited_by: "user-one",
            relay_id: relayId,
            token_hash: "p".repeat(64),
          })
          yield* insertRows("permission_preset", {
            created_at: now,
            id: "preset",
            name: "preset",
            relay_id: relayId,
            resource_id: databaseId,
            resource_type: "database",
            updated_at: now,
          })
          yield* insertFavorite("user-one", "database", databaseId)
          yield* insertFavorite("user-two", "database", databaseId)
          yield* insertFavorite("user-one", "database", otherDatabaseId)
          yield* insertIcon("database", databaseId)
          const deleted = { id: databaseId, name: "main", relayId }
          const other = { id: otherDatabaseId, name: "other", relayId }
          const remote = {
            id: remoteDatabaseId,
            name: "remote",
            relayId: otherRelayId,
          }
          yield* insertRelay(otherRelayId)
          // A backup step that names the deleted database and another.
          yield* insertSchedule(
            sharedSchedule,
            [deleted, other],
            [
              {
                destination: { kind: "local" },
                mode: "full",
                name: "Nightly",
                targetKeys: [
                  keyOf(relayId, databaseId),
                  keyOf(relayId, otherDatabaseId),
                ],
                type: "backup",
              },
            ]
          )
          yield* insertSchedule(crossRelaySchedule, [deleted, remote])
          yield* insertSchedule(aloneSchedule, [deleted])
          relays.applied.length = 0
          relays.removed.length = 0

          yield* cleanUpDeletedResourceEffect(
            { id: databaseId, kind: "database", relayId },
            "user-one"
          ).pipe(Effect.provide(disabledCache))

          assert.sameMembers(
            ids(
              yield* selectRows<{ database_id: string }>("database"),
              "database_id"
            ),
            [otherDatabaseId]
          )
          assert.sameMembers(
            ids(yield* selectRows<{ id: string }>("access_grant"), "id"),
            ["grant-other"]
          )
          assert.lengthOf(yield* selectRows("invitation"), 0)
          assert.lengthOf(yield* selectRows("permission_preset"), 0)
          // Relays drop what they cached for the person who lost access.
          const subjects = yield* selectRows<{
            revision: number
            user_id: string
          }>("authorization_subject")
          assert.deepStrictEqual(
            subjects.map((row) => [row.user_id, Number(row.revision)]),
            [["user-one", 1]]
          )
          assert.deepStrictEqual(relays.woken, [relayId])
          assert.deepStrictEqual(
            (yield* selectRows<{ resource_id: string; user_id: string }>(
              "instance_favorite"
            )).map((row) => [row.user_id, row.resource_id]),
            [["user-one", otherDatabaseId]]
          )
          assert.lengthOf(yield* selectRows("icon"), 0)

          // A schedule keeps its other targets, saved and sent again; one
          // with nothing left to run on is deleted.
          const liveTargets = (yield* selectRows<{
            relay_id: string
            schedule_id: string
            target_id: string
          }>("schedule_target"))
            .filter((row) => row.schedule_id !== aloneSchedule)
            .map((row) => [row.schedule_id, row.target_id])
            .sort(byKey)
          assert.deepStrictEqual(
            liveTargets,
            [
              [sharedSchedule, otherDatabaseId],
              [crossRelaySchedule, remoteDatabaseId],
            ].sort(byKey)
          )
          const [backupAction] = yield* selectRows<{
            action_config: unknown
            schedule_id: string
          }>("schedule_action").pipe(
            Effect.map((rows) =>
              rows.filter((row) => row.schedule_id === sharedSchedule)
            )
          )
          const config = (
            typeof backupAction?.action_config === "string"
              ? JSON.parse(backupAction.action_config)
              : backupAction?.action_config
          ) as { targetKeys: Array<string> }
          assert.deepStrictEqual(config.targetKeys, [
            keyOf(relayId, otherDatabaseId),
          ])
          const schedules = yield* selectRows<{
            deleted_at: number | null
            id: string
            revision: number
          }>("schedule")
          assert.deepStrictEqual(
            schedules
              .map((row) => [
                row.id,
                Number(row.revision),
                row.deleted_at !== null,
              ])
              .sort(byKey),
            [
              [sharedSchedule, 5, false],
              [crossRelaySchedule, 5, false],
              [aloneSchedule, 5, true],
            ].sort(byKey)
          )
          // Each Relay acknowledged what it now runs, and the one a schedule
          // left dropped it.
          const deployments = (yield* selectRows<{
            acknowledged_revision: number
            relay_id: string
            schedule_id: string
            status: string
          }>("schedule_deployment"))
            .map((row) => [
              row.schedule_id,
              row.relay_id,
              row.status,
              Number(row.acknowledged_revision),
            ])
            .sort(byKey)
          assert.deepStrictEqual(
            deployments,
            [
              [sharedSchedule, relayId, "applied", 5],
              [crossRelaySchedule, otherRelayId, "applied", 5],
            ].sort(byKey)
          )

          // Running it again, as a retried deletion does, changes nothing.
          yield* cleanUpDeletedResourceEffect(
            { id: databaseId, kind: "database", relayId },
            "user-one"
          ).pipe(Effect.provide(disabledCache))
          assert.deepStrictEqual(
            (yield* selectRows<{ id: string; revision: number }>("schedule"))
              .map((row) => [row.id, Number(row.revision)])
              .sort(byKey),
            [
              [sharedSchedule, 5],
              [crossRelaySchedule, 5],
              [aloneSchedule, 5],
            ].sort(byKey)
          )
        })
    )
  })
})
