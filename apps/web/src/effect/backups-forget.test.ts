import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { forgetBackupEffect, forgetRelayBackupsEffect } from "@/effect/backups"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRelay, insertRows, selectRows } from "@/test/seed"

const at = 1_767_225_600_000

const insertRepository = (id: string, relayId: string, targetId: string) =>
  insertRows("backup_repository", {
    id,
    relay_id: relayId,
    target_kind: "instance",
    target_id: targetId,
    password_ciphertext: "repository-password",
    created_at: at,
  })

const insertPolicy = (relayId: string, targetId: string) =>
  insertRows("backup_policy", {
    relay_id: relayId,
    target_kind: "instance",
    target_id: targetId,
    exclude_patterns: "[]",
    created_at: at,
    updated_at: at,
  })

// A backup with the rows that hang off it: an artifact, a finished task, a
// download share, and a final-deletion record that blocks its removal.
const insertBackupWithDependents = (
  id: string,
  row: { relay_id: string; target_id: string; repository_id: string | null }
) =>
  Effect.gen(function* () {
    yield* insertBackup(id, row)
    yield* insertRows("backup_artifact", {
      id: `${id}-artifact`,
      backup_id: id,
      destination_key: "local",
      status: "available",
      created_at: at,
      updated_at: at,
    })
    yield* insertRows("backup_task", {
      id: `${id}-task`,
      backup_id: id,
      task_kind: "create",
      status: "succeeded",
      created_at: at,
      updated_at: at,
    })
    yield* insertRows("backup_download_share", {
      token_hash: id.padEnd(64, "0"),
      download_url_ciphertext: "url",
      backup_id: id,
      backup_name: id,
      filename: `${id}.zip`,
      artifact_kind: "archive",
      target_kind: "instance",
      target_id: row.target_id,
      source_name: row.target_id,
      shared_by: "user-one",
      backup_created_at: at,
      expires_at: at,
      created_at: at,
    })
    yield* insertRows("backup_final_delete", {
      relay_id: row.relay_id,
      target_id: row.target_id,
      backup_id: id,
      requested_by: "user-one",
      status: "failed",
      created_at: at,
      updated_at: at,
    })
  })

const ids = (table: string) =>
  selectRows<{ id: string }>(table).pipe(
    Effect.map((rows) => rows.map((row) => row.id).sort())
  )

const backupIdsIn = (table: string) =>
  selectRows<{ backup_id: string }>(table).pipe(
    Effect.map((rows) => rows.map((row) => row.backup_id).sort())
  )

const policyTargets = selectRows<{ relay_id: string; target_id: string }>(
  "backup_policy"
).pipe(
  Effect.map((rows) =>
    rows.map((row) => `${row.relay_id}/${row.target_id}`).sort()
  )
)

describeMysql("backup forgetting", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "forgets one backup and only the metadata nothing else uses",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          // backup-one is alone in its repository and target; backup-two and
          // backup-three share theirs.
          yield* insertRepository(
            "repository-one",
            "relay-gone",
            "instance-one"
          )
          yield* insertRepository(
            "repository-two",
            "relay-gone",
            "instance-two"
          )
          yield* insertPolicy("relay-gone", "instance-one")
          yield* insertPolicy("relay-gone", "instance-two")
          yield* insertBackupWithDependents("backup-one", {
            relay_id: "relay-gone",
            target_id: "instance-one",
            repository_id: "repository-one",
          })
          yield* insertBackup("backup-two", {
            relay_id: "relay-gone",
            target_id: "instance-two",
            repository_id: "repository-two",
          })
          yield* insertBackupWithDependents("backup-three", {
            relay_id: "relay-gone",
            target_id: "instance-two",
            repository_id: "repository-two",
          })

          assert.strictEqual(
            yield* forgetBackupEffect("backup-one"),
            "forgotten"
          )
          assert.strictEqual(
            yield* forgetBackupEffect("backup-three"),
            "forgotten"
          )

          assert.deepStrictEqual(yield* ids("backup"), ["backup-two"])
          assert.deepStrictEqual(yield* ids("backup_repository"), [
            "repository-two",
          ])
          assert.deepStrictEqual(yield* policyTargets, [
            "relay-gone/instance-two",
          ])
          for (const table of [
            "backup_artifact",
            "backup_task",
            "backup_download_share",
            "backup_final_delete",
          ]) {
            assert.deepStrictEqual(yield* backupIdsIn(table), [], table)
          }
        })
    )

    it.effect("leaves everything in place when the backup is missing", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRepository("repository-one", "relay-gone", "instance-one")
        yield* insertPolicy("relay-gone", "instance-one")
        yield* insertBackupWithDependents("backup-one", {
          relay_id: "relay-gone",
          target_id: "instance-one",
          repository_id: "repository-one",
        })

        assert.strictEqual(
          yield* forgetBackupEffect("missing-backup"),
          "not_found"
        )

        assert.deepStrictEqual(yield* ids("backup"), ["backup-one"])
        assert.deepStrictEqual(yield* ids("backup_repository"), [
          "repository-one",
        ])
        assert.deepStrictEqual(yield* policyTargets, [
          "relay-gone/instance-one",
        ])
      })
    )

    it.effect("refuses to forget a backup whose Relay is still paired", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one")
        yield* insertRepository("repository-one", "relay-one", "instance-one")
        yield* insertPolicy("relay-one", "instance-one")
        yield* insertBackupWithDependents("backup-one", {
          relay_id: "relay-one",
          target_id: "instance-one",
          repository_id: "repository-one",
        })

        assert.strictEqual(
          yield* forgetBackupEffect("backup-one"),
          "relay_present"
        )

        assert.deepStrictEqual(yield* ids("backup"), ["backup-one"])
        assert.deepStrictEqual(yield* ids("backup_artifact"), [
          "backup-one-artifact",
        ])
        assert.deepStrictEqual(yield* backupIdsIn("backup_final_delete"), [
          "backup-one",
        ])
        assert.deepStrictEqual(yield* ids("backup_repository"), [
          "repository-one",
        ])
        assert.deepStrictEqual(yield* policyTargets, ["relay-one/instance-one"])
      })
    )

    it.effect("forgets every backup of a removed Relay and nothing else", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        for (const relayId of ["relay-gone", "relay-kept"]) {
          yield* insertRepository(`${relayId}-repo`, relayId, "instance-one")
          yield* insertPolicy(relayId, "instance-one")
        }
        yield* insertBackupWithDependents("backup-one", {
          relay_id: "relay-gone",
          target_id: "instance-one",
          repository_id: "relay-gone-repo",
        })
        yield* insertBackup("backup-two", {
          relay_id: "relay-gone",
          target_id: "instance-two",
          repository_id: null,
        })
        yield* insertBackupWithDependents("backup-kept", {
          relay_id: "relay-kept",
          target_id: "instance-one",
          repository_id: "relay-kept-repo",
        })

        assert.strictEqual(yield* forgetRelayBackupsEffect("relay-gone"), 2)

        assert.deepStrictEqual(yield* ids("backup"), ["backup-kept"])
        assert.deepStrictEqual(yield* ids("backup_repository"), [
          "relay-kept-repo",
        ])
        assert.deepStrictEqual(yield* policyTargets, [
          "relay-kept/instance-one",
        ])
        for (const table of [
          "backup_artifact",
          "backup_task",
          "backup_download_share",
          "backup_final_delete",
        ]) {
          assert.deepStrictEqual(
            yield* backupIdsIn(table),
            ["backup-kept"],
            table
          )
        }
      })
    )
  })
})
