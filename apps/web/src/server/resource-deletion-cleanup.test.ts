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
  applied: [] as Array<{ id: string; revision: number; targets: unknown }>,
  removed: [] as Array<string>,
  woken: [] as Array<string>,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { id?: string; revision: number; scheduleId?: string }
  ) => {
    if (operation === "schedule.apply") {
      relays.applied.push({
        id: payload.id ?? "",
        revision: payload.revision,
        targets: (payload as { targets?: unknown }).targets,
      })
      return { nextRunAt: null, revision: payload.revision }
    }
    if (operation === "schedule.remove") {
      relays.removed.push(payload.scheduleId ?? "")
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
const databaseId = "d".repeat(40)
const otherDatabaseId = "e".repeat(40)
const appId = "a".repeat(40)
const otherAppId = "b".repeat(40)
const now = 1_700_000_000_000
const sharedSchedule = "11111111-1111-4111-8111-111111111111"
const aloneSchedule = "22222222-2222-4222-8222-222222222222"

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

const insertApp = (id: string, name: string) =>
  insertRows("app", {
    app_id: id,
    config_ciphertext: "ciphertext",
    created_at: now,
    created_by: "user-one",
    name,
    relay_id: relayId,
    updated_at: now,
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
  targets: ReadonlyArray<{ id: string; kind: string; name: string }>
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
    const actionId = id.replace(/^./u, "a")
    yield* insertRows("schedule_action", {
      action_config: JSON.stringify({
        duration: 5,
        id: actionId,
        type: "wait",
        unit: "seconds",
      }),
      action_type: "wait",
      created_at: now,
      id: actionId,
      position: 0,
      schedule_id: id,
    })
    for (const target of targets) {
      yield* insertRows("schedule_target", {
        created_at: now,
        relay_id: relayId,
        schedule_id: id,
        target_id: target.id,
        target_kind: target.kind,
        target_name: target.name,
      })
    }
  })

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
          relays.applied.length = 0
          relays.removed.length = 0
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
          yield* insertSchedule(sharedSchedule, [
            { id: databaseId, kind: "database", name: "main" },
            { id: otherDatabaseId, kind: "database", name: "other" },
          ])
          yield* insertSchedule(aloneSchedule, [
            { id: databaseId, kind: "database", name: "main" },
          ])

          yield* cleanUpDeletedResourceEffect(
            { id: databaseId, kind: "database", relayId },
            "user-one"
          ).pipe(Effect.provide(disabledCache))

          assert.sameMembers(
            ids(yield* selectRows<{ database_id: string }>("database"), "database_id"),
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
          const targets = yield* selectRows<{
            schedule_id: string
            target_id: string
          }>("schedule_target")
          assert.deepStrictEqual(
            targets
              .filter((row) => row.schedule_id === sharedSchedule)
              .map((row) => row.target_id),
            [otherDatabaseId]
          )
          const schedules = yield* selectRows<{
            deleted_at: number | null
            id: string
            revision: number
          }>("schedule")
          assert.deepStrictEqual(
            schedules
              .map((row) => [row.id, Number(row.revision), row.deleted_at !== null])
              .sort(),
            [
              [sharedSchedule, 5, false],
              [aloneSchedule, 5, true],
            ].sort()
          )
          assert.deepStrictEqual(
            relays.applied.map((schedule) => [schedule.id, schedule.revision]),
            [[sharedSchedule, 5]]
          )
          assert.deepStrictEqual(relays.removed, [aloneSchedule])
        })
    )

    it.effect("takes an App's GitHub syncs, favorites, icon, and record", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId)
        yield* insertApp(appId, "site")
        yield* insertApp(otherAppId, "other")
        yield* insertRows("github_connection", {
          app_id: 1,
          app_name: "Kiln",
          app_owner_login: "kiln",
          app_slug: "kiln",
          app_url: "https://github.com/apps/kiln",
          client_id: "client",
          created_at: now,
          credentials_ciphertext: "ciphertext",
          id: "connection",
          owner_user_id: "user-one",
          updated_at: now,
        })
        for (const [id, resourceId] of [
          ["sync-deleted", appId],
          ["sync-other", otherAppId],
        ]) {
          yield* insertRows("github_sync", {
            branch: "main",
            connection_id: "connection",
            created_at: now,
            created_by: "user-one",
            id,
            include_patterns: "[]",
            relay_id: relayId,
            repository: "kiln/site",
            repository_id: 1,
            resource_id: resourceId,
            resource_kind: "app",
            synced_files: "[]",
            updated_at: now,
          })
        }
        yield* insertFavorite("user-one", "app", appId)
        yield* insertFavorite("user-one", "app", otherAppId)
        yield* insertIcon("app", appId)
        yield* insertIcon("app", otherAppId)

        yield* cleanUpDeletedResourceEffect(
          { id: appId, kind: "app", relayId },
          "user-one"
        ).pipe(Effect.provide(disabledCache))

        assert.sameMembers(
          ids(yield* selectRows<{ app_id: string }>("app"), "app_id"),
          [otherAppId]
        )
        assert.sameMembers(
          ids(yield* selectRows<{ id: string }>("github_sync"), "id"),
          ["sync-other"]
        )
        assert.sameMembers(
          ids(
            yield* selectRows<{ resource_id: string }>("instance_favorite"),
            "resource_id"
          ),
          [otherAppId]
        )
        assert.sameMembers(
          ids(yield* selectRows<{ subject_id: string }>("icon"), "subject_id"),
          [otherAppId]
        )
      })
    )
  })
})
