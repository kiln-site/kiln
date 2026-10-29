import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber, Result } from "effect"
import { SqlClient } from "effect/sql"

import {
  reserveBackupBatchEffect,
  type BackupCreateReservation,
} from "@/effect/backups"
import { databaseTableName } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackupStorage,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const volumeId = `${appId}/pgdata`
const at = Date.UTC(2026, 0, 1)

const reservation = (
  storageId: string,
  target: { id: string; kind: "app" | "volume" }
): BackupCreateReservation => ({
  artifactKind: "tar_archive",
  backupId: randomUUID(),
  batchId: "11111111-1111-4111-8111-111111111111",
  batchSize: 2,
  consistency: "live",
  createdBy: "member",
  exclude: [],
  mode: "full",
  name: "Before the upgrade",
  relayId,
  requestedMaxBytes: null,
  storageIds: [storageId],
  targetId: target.id,
  targetKind: target.kind,
  taskId: randomUUID(),
})

describeMysql("App backup batch reservation", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "waits for a volume's backup reserved meanwhile, rather than deadlock with it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          const storageId = randomUUID()
          yield* insertBackupStorage(storageId)
          yield* insertRows("backup_policy", {
            created_at: at,
            exclude_patterns: "[]",
            relay_id: relayId,
            target_id: volumeId,
            target_kind: "volume",
            updated_at: at,
          })
          const sql = yield* SqlClient.SqlClient
          const policy = databaseTableName("backup_policy")
          const storage = databaseTableName("backup_storage")
          const policyHeld = yield* Deferred.make<void>()
          const proceed = yield* Deferred.make<void>()

          // A reservation of the volume alone, as one backup's: its policy,
          // then the destination.
          const single = yield* Effect.forkChild(
            sql.withTransaction(
              Effect.gen(function* () {
                yield* sql`SELECT target_id FROM ${sql(policy)}
                  WHERE relay_id = ${relayId} AND target_kind = 'volume'
                    AND target_id = ${volumeId} FOR UPDATE`
                yield* Deferred.succeed(policyHeld, undefined)
                yield* Deferred.await(proceed)
                yield* sql`SELECT id FROM ${sql(storage)}
                  WHERE id = ${storageId} FOR UPDATE`
              })
            )
          )
          yield* Deferred.await(policyHeld)
          const batch = yield* Effect.forkChild(
            reserveBackupBatchEffect([
              reservation(storageId, { id: appId, kind: "app" }),
              reservation(storageId, { id: volumeId, kind: "volume" }),
            ])
          )
          // The batch waits on a backup policy lock in this test's database
          // before the volume's reservation goes on; waits elsewhere on the
          // server don't count.
          let waiting = 0
          for (
            let attempt = 0;
            attempt < 2_000 && waiting === 0;
            attempt += 1
          ) {
            yield* Effect.yieldNow
            const [row] = yield* sql<{ count: number }>`
              SELECT COUNT(*) AS count
                FROM performance_schema.data_lock_waits waits
                JOIN performance_schema.data_locks requested
                  ON requested.ENGINE = waits.ENGINE
                 AND requested.ENGINE_LOCK_ID = waits.REQUESTING_ENGINE_LOCK_ID
               WHERE requested.OBJECT_SCHEMA = DATABASE()
                 AND requested.OBJECT_NAME = ${policy}`
            waiting = Number(row?.count ?? 0)
          }
          assert.isAbove(waiting, 0)
          yield* Deferred.succeed(proceed, undefined)

          assert.isTrue(
            Result.isSuccess(yield* Effect.result(Fiber.join(single)))
          )
          const reserved = yield* Fiber.join(batch)
          assert.lengthOf(reserved, 2)
          assert.lengthOf(yield* selectRows("backup"), 2)
        })
    )
  })
})
