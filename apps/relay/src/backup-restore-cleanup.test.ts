import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { afterAll, assert, describe, it } from "@effect/vitest"
import { Effect, Exit } from "effect"
import { vi } from "vite-plus/test"

import type {
  BackupCreateTaskInput,
  BackupRestoreTaskInput,
} from "@workspace/contracts"

const cleanupFailure = vi.hoisted(() => ({
  remaining: 0,
  rollbackPath: "",
}))

vi.mock("node:fs/promises", async (importOriginal) => {
  const filesystem = await importOriginal<typeof import("node:fs/promises")>()
  return {
    ...filesystem,
    rm: async (
      path: Parameters<typeof filesystem.rm>[0],
      options?: Parameters<typeof filesystem.rm>[1]
    ) => {
      if (
        cleanupFailure.remaining > 0 &&
        String(path) === cleanupFailure.rollbackPath
      ) {
        const exists = await filesystem
          .stat(path)
          .then(() => true)
          .catch(() => false)
        if (exists) {
          cleanupFailure.remaining -= 1
          throw new Error("Injected post-install cleanup failure")
        }
      }
      return filesystem.rm(path, options)
    },
  }
})

import { restorePortableInstanceBackup } from "./backup-restore.js"
import { BackupManager } from "./backups.js"
import { makeRelayStateLayer } from "./effect/state.js"
import { testInstance, testRelayConfig } from "./test/fixtures.js"

const testDirectory = mkdtempSync(
  resolve(tmpdir(), "kiln-backup-restore-cleanup-")
)

afterAll(() => {
  cleanupFailure.remaining = 0
  rmSync(testDirectory, { force: true, recursive: true })
})

describe("Relay backup restore cleanup", () => {
  it.effect("keeps an installed restore when rollback cleanup fails", () =>
    Effect.gen(function* () {
      const config = testRelayConfig(testDirectory)
      const instance = testInstance()
      const root = resolve(config.rootDirectory, instance.directory)
      yield* Effect.promise(() => mkdir(root, { recursive: true }))
      yield* Effect.promise(() => writeFile(resolve(root, "server.txt"), "old"))
      const create = backupInput()
      const manager = yield* BackupManager.make({
        config,
        findInstance: async () => instance,
        isInstanceStopped: async () => true,
      })
      yield* manager.enqueue(create)
      yield* manager.runPending()
      const created = (yield* manager.get(create.taskId))?.result
      if (!created || !("checksumSha256" in created)) {
        return assert.fail("The backup archive was not created")
      }
      yield* Effect.promise(() => writeFile(resolve(root, "server.txt"), "new"))

      const restore: BackupRestoreTaskInput & { kind: "restore" } = {
        backupId: create.backupId,
        kind: "restore",
        source: {
          bytes: created.bytes,
          checksumSha256: created.checksumSha256,
          kind: "local",
        },
        target: create.target,
        taskId: "20000000-0000-4000-8000-000000000009",
      }
      cleanupFailure.rollbackPath = resolve(
        config.rootDirectory,
        `.instance-1.kiln-rollback-${restore.taskId}`
      )
      cleanupFailure.remaining = 1
      const outcome = yield* Effect.exit(
        Effect.tryPromise({
          try: () => restorePortableInstanceBackup(config, restore, instance),
          catch: (cause) => cause,
        })
      )
      cleanupFailure.remaining = 0

      assert.isTrue(Exit.isSuccess(outcome))
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(resolve(root, "server.txt"), "utf8")
        ),
        "old"
      )
      assert.isFalse(existsSync(cleanupFailure.rollbackPath))
      assert.isFalse(
        existsSync(resolve(testDirectory, "restores", `${restore.taskId}.json`))
      )
    }).pipe(
      Effect.provide(
        makeRelayStateLayer(resolve(testDirectory, "relay.sqlite"))
      )
    )
  )
})

function backupInput(): BackupCreateTaskInput & { kind: "create" } {
  return {
    artifactKind: "archive",
    backupId: "00000000-0000-4000-8000-000000000009",
    destination: { kind: "local" },
    exclude: [],
    kind: "create",
    maxBytes: 100 * 1024 * 1024,
    mode: "full",
    reason: "manual",
    target: { id: "instance-1", kind: "instance" },
    taskId: "10000000-0000-4000-8000-000000000009",
  }
}
