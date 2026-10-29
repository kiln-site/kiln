import { describe, expect, it } from "vite-plus/test"
import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { listTargetBackupsEffect } from "@/effect/backups"
import {
  backupShowsPrimaryTaskFeedback,
  backupDisplayBytes,
} from "@/lib/backup-progress-presentation"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertBackup, insertRows } from "@/test/seed"

describeMysql("App backup outcomes after restore", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps a refused restore separate from successful backups, even after a safety backup",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const appId = "a".repeat(40)
          for (const [id, kind, targetId, createdAt, batchId] of [
            ["folder", "app", appId, 1000, "batch"],
            ["volume", "volume", `${appId}/data`, 1000, "batch"],
            ["safety", "app", appId, 2000, null],
          ] as const) {
            yield* insertBackup(id, {
              target_kind: kind,
              target_id: targetId,
              relay_id: "relay-a",
              status: "available",
              bytes: 1234,
              created_at: createdAt,
              batch_id: batchId,
            })
            yield* insertRows("backup_task", {
              id: `${id}-create`,
              backup_id: id,
              task_kind: "create",
              status: "succeeded",
              created_at: createdAt,
              updated_at: createdAt,
            })
          }
          yield* insertRows("backup_task", {
            id: "refused",
            backup_id: "folder",
            task_kind: "restore",
            status: "failed",
            error: "Stop the App first",
            created_at: 3000,
            updated_at: 3000,
          })
          // Downloading the backup afterwards doesn't hide the refusal.
          yield* insertRows("backup_task", {
            id: "export",
            backup_id: "folder",
            task_kind: "export",
            status: "succeeded",
            created_at: 4000,
            updated_at: 4000,
          })
          const result = yield* listTargetBackupsEffect("relay-a", [
            { id: appId, kind: "app" },
            { id: `${appId}/data`, kind: "volume" },
          ])
          assert.deepEqual(
            result.batch.map((backup) => backup.status),
            ["available", "available"]
          )
          assert.equal(
            result.latest.find((backup) => backup.targetKind === "app")?.id,
            "safety"
          )
          const restore = result.restores[0]!
          assert.equal(restore.taskError, "Stop the App first")
          assert.isFalse(backupShowsPrimaryTaskFeedback(restore))
          assert.equal(backupDisplayBytes(restore), 1234)
        })
    )
  })
})

describe("backup creation feedback", () => {
  it("shows the backup size after a failed restore and preserves create and delete failures", () => {
    const backup = {
      artifacts: [],
      bytes: 1234,
      taskBytesCompleted: 0,
      taskBytesTotal: null,
      taskCurrentArtifactId: null,
      taskError: "refused",
      taskPhase: null,
      taskStatus: "failed" as const,
    }
    expect(
      backupShowsPrimaryTaskFeedback({ ...backup, taskKind: "restore" })
    ).toBe(false)
    expect(backupDisplayBytes(backup)).toBe(1234)
    expect(
      backupShowsPrimaryTaskFeedback({ ...backup, taskKind: "create" })
    ).toBe(true)
    expect(
      backupShowsPrimaryTaskFeedback({ ...backup, taskKind: "delete" })
    ).toBe(true)
  })
})
