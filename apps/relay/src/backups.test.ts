import { createHash } from "node:crypto"
import { createWriteStream, existsSync, rmSync } from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { setImmediate as yieldToEventLoop } from "node:timers/promises"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"
import ZipStream from "zip-stream"

import type {
  BackupArchiveCreateTaskResult,
  BackupCreateTaskInput,
  BackupTaskInput,
  RelayBackupTask,
} from "@workspace/contracts"
import {
  brickRecipeFromV1,
  brickRecipeSchema,
  brickRecipeV1Schema,
} from "@workspace/contracts"

import {
  recoverInterruptedRestores,
  restorePortableInstanceBackup,
} from "./backup-restore.js"
import { BackupManager } from "./backups.js"
import { backupStorageAccessThrough } from "./backups/storage-access.js"
import { backupArchivePath } from "./backups/destinations/index.js"
import { BrickCatalog, brickSnapshotDirectory } from "./bricks.js"
import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import {
  noBucket,
  noHearth,
  testInstance,
  testRelayConfig,
} from "./test/fixtures.js"
import { OperationLanes } from "./operation-lanes.js"

// A bucket, as the Relay reaches one: over HTTPS, with a request Hearth
// signed. It keeps what is sent to it as `object`, serves that back, and
// remembers what was asked of it.
const bucket = vi.hoisted(() => ({
  asked: [] as Array<{
    headers: unknown
    method: string | undefined
    url: string
  }>,
  object: Buffer.alloc(0),
}))

vi.mock("node:https", async (importOriginal) => {
  const https = await importOriginal<typeof import("node:https")>()
  const { PassThrough, Writable } = await import("node:stream")
  const request = (
    url: URL,
    options: { headers?: unknown; method?: string },
    respond: (response: unknown) => void
  ) => {
    bucket.asked.push({
      headers: options.headers,
      method: options.method,
      url: url.toString(),
    })
    const sent: Array<Buffer> = []
    const body = new Writable({
      write(chunk: Buffer, _encoding, written) {
        sent.push(chunk)
        written()
      },
    })
    body.once("finish", () => {
      if (options.method === "PUT") bucket.object = Buffer.concat(sent)
      const response = Object.assign(new PassThrough(), { statusCode: 200 })
      respond(response)
      response.end(options.method === "GET" ? bucket.object : undefined)
    })
    return Object.assign(body, { setTimeout: () => body })
  }
  return { ...https, default: { ...https, request }, request }
})

// The Relay holds no keys to a bucket. For each copy it asks the Hearth
// its task came from, and uses the one request that Hearth signs.
describe("Relay backups in a bucket it holds no keys to", () => {
  const hearthId = "hearth-one"
  const copy = "30000000-0000-4000-8000-000000000003"
  const signed = (method: "PUT" | "GET" | "DELETE") => ({
    allowPrivateNetwork: false,
    headers: method === "PUT" ? { "content-type": "application/zip" } : {},
    method,
    status: "granted" as const,
    url: `https://kiln-backups.s3.example.com/team/backup.zip?X-Amz-Signature=${method}`,
  })
  // The Hearth these tasks came from, and what it answers each request.
  const hearth = (answer: (action: string, artifactId: string) => unknown) => {
    const asked: Array<unknown> = []
    return {
      asked,
      options: {
        storage: backupStorageAccessThrough(async (request, _timeout, only) => {
          if (!only({ id: hearthId, role: "full_access" })) return []
          asked.push(request)
          return [
            { payload: await answer(request.action, request.artifactId) },
          ]
        }),
      },
    }
  }

  it.effect(
    "sends, reads back and deletes an archive with one signed request each, asked of its task's Hearth",
    () =>
      withRelay("kiln-backup-bucket-", ({ config, root }) =>
        Effect.gen(function* () {
          const file = resolve(root, "world.txt")
          yield* Effect.promise(() => writeFile(file, "as backed up"))
          bucket.asked.length = 0
          const { asked, options } = hearth((action) =>
            signed(
              action === "upload"
                ? "PUT"
                : action === "download"
                  ? "GET"
                  : "DELETE"
            )
          )
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const create = {
            ...backupInput(31),
            destination: { artifactId: copy, kind: "s3" as const },
          }
          const stored = yield* runTask(manager, create, hearthId)
          assert.strictEqual(stored.status, "succeeded", stored.error ?? "")
          const taken = archiveResult(stored)
          // In the bucket, and not kept on the Relay.
          assert.strictEqual(sha256(bucket.object), taken.checksumSha256)
          assert.isFalse(
            existsSync(backupArchivePath(config, create.backupId))
          )

          yield* Effect.promise(() => writeFile(file, "changed since"))
          const restored = yield* runTask(
            manager,
            {
              backupId: create.backupId,
              kind: "restore" as const,
              source: {
                artifactId: copy,
                bytes: taken.bytes,
                checksumSha256: taken.checksumSha256,
                kind: "remote" as const,
              },
              target: create.target,
              taskId: "20000000-0000-4000-8000-000000000031",
            },
            hearthId
          )
          assert.strictEqual(restored.status, "succeeded", restored.error ?? "")
          assert.strictEqual(
            yield* Effect.promise(() => readFile(file, "utf8")),
            "as backed up"
          )

          const deleted = yield* runTask(
            manager,
            {
              backupId: create.backupId,
              destination: { artifactId: copy, kind: "s3" as const },
              kind: "delete" as const,
              target: create.target,
              taskId: "10000000-0000-4000-8000-000000000032",
            },
            hearthId
          )
          assert.strictEqual(deleted.status, "succeeded", deleted.error ?? "")

          assert.deepStrictEqual(asked, [
            { action: "upload", artifactId: copy },
            { action: "download", artifactId: copy },
            { action: "delete", artifactId: copy },
          ])
          assert.deepStrictEqual(
            bucket.asked.map(({ method, url }) => ({ method, url })),
            (["PUT", "GET", "DELETE"] as const).map((method) => ({
              method,
              url: signed(method).url,
            }))
          )
        })
      )
  )

  it.effect(
    "fails a backup to a bucket when its Hearth refuses, sending it nothing",
    () =>
      withRelay("kiln-backup-bucket-refused-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          bucket.asked.length = 0
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth(() => ({
              reason: "the copy is available",
              status: "refused",
            })).options
          )
          const task = yield* runTask(manager, toBucket(33), hearthId)
          assert.strictEqual(task.status, "failed")
          assert.include(task.error ?? "", "the copy is available")
          assert.deepStrictEqual(bucket.asked, [])
          assert.isFalse(existsSync(backupArchivePath(config, task.backupId)))
        })
      )
  )

  // A Hearth that is there or isn't, as one that restarts is.
  const comesAndGoes = () => {
    const state = { away: true }
    return {
      ...hearth(() => (state.away ? null : signed("PUT"))),
      state,
    }
  }
  const toBucket = (index: number) => ({
    ...backupInput(index),
    destination: { artifactId: copy, kind: "s3" as const },
  })
  const archiveOf = (config: RelayConfig, index: number) =>
    backupArchivePath(config, backupInput(index).backupId)

  // A backup is of the moment it was taken, so what waits is what is sent.
  it.effect(
    "keeps a backup its Hearth was away for, and sends what it took once the Hearth is back",
    () =>
      withRelay("kiln-backup-waits-", ({ config, root }) =>
        Effect.gen(function* () {
          const file = resolve(root, "world.txt")
          yield* Effect.promise(() => writeFile(file, "as backed up"))
          bucket.asked.length = 0
          const { options, state } = comesAndGoes()
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )

          const waiting = yield* runTask(manager, toBucket(41), hearthId)
          assert.strictEqual(waiting.status, "queued")
          assert.strictEqual(waiting.phase, "uploading")
          assert.deepStrictEqual(bucket.asked, [])
          const taken = sha256(
            yield* Effect.promise(() => readFile(archiveOf(config, 41)))
          )
          // Nothing is asked again before the wait is up or it connects.
          yield* manager.runPending()
          assert.strictEqual(
            (yield* manager.get(waiting.taskId))?.status,
            "queued"
          )

          yield* Effect.promise(() => writeFile(file, "changed since"))
          state.away = false
          yield* manager.hearthConnected(hearthId)
          yield* manager.runPending()

          const sent = (yield* manager.get(waiting.taskId))!
          assert.strictEqual(sent.status, "succeeded", sent.error ?? "")
          assert.strictEqual(archiveResult(sent).checksumSha256, taken)
          assert.strictEqual(sha256(bucket.object), taken)
          assert.isFalse(existsSync(archiveOf(config, 41)))
        })
      )
  )

  it.effect(
    "sends what it took after a restart, whether it was waiting or being sent",
    () =>
      withRelay("kiln-backup-waits-restart-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "as backed up")
          )
          const { options, state } = comesAndGoes()
          const before = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const waiting = yield* runTask(before, toBucket(42), hearthId)
          assert.strictEqual(waiting.status, "queued")
          const taken = sha256(
            yield* Effect.promise(() => readFile(archiveOf(config, 42)))
          )
          // Its turn comes again, and the Relay stops as the send is under
          // way.
          const journal = yield* RelayStateStore
          yield* journal.rescheduleWaitingBackupTasks(hearthId, Date.now())
          yield* journal.claimNextBackupTask(Date.now())
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "changed since")
          )

          const after = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          state.away = false
          yield* after.runPending()

          const sent = (yield* after.get(waiting.taskId))!
          assert.strictEqual(sent.status, "succeeded", sent.error ?? "")
          assert.strictEqual(sha256(bucket.object), taken)
        })
      )
  )

  // Stopping the Relay ends its worker. Whatever becomes of the send under
  // way, nothing is recorded as ended, so what the backup took is still
  // there to send when the Relay starts.
  it.effect("keeps what it took when the Relay stops while sending it", () =>
    withRelay("kiln-backup-waits-stop-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "world.txt"), "as backed up")
        )
        const silent = hearth(() => new Promise(() => {}))
        const before = yield* backupManager(
          config,
          undefined,
          undefined,
          silent.options
        )
        const create = toBucket(46)
        yield* before.enqueue(create, hearthId)
        const run = yield* Effect.forkChild(before.runPending())
        while (silent.asked.length === 0) {
          yield* Effect.promise(() => yieldToEventLoop())
        }
        const taken = sha256(
          yield* Effect.promise(() => readFile(archiveOf(config, 46)))
        )

        yield* Fiber.interrupt(run)
        const after = yield* backupManager(
          config,
          undefined,
          undefined,
          hearth(() => signed("PUT")).options
        )
        yield* after.runPending()

        const sent = (yield* after.get(create.taskId))!
        assert.strictEqual(sent.status, "succeeded", sent.error ?? "")
        assert.strictEqual(sha256(bucket.object), taken)
      })
    )
  )

  // Each waits out its own minute.
  it.effect(
    "sends a waiting backup though its Hearth still won't answer for an older one",
    () =>
      withRelay("kiln-backup-waits-each-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const unanswered = "30000000-0000-4000-8000-000000000006"
          const state = { away: true }
          const { options } = hearth((_action, artifactId) =>
            state.away || artifactId === unanswered ? null : signed("PUT")
          )
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const older = yield* runTask(
            manager,
            {
              ...backupInput(47),
              destination: { artifactId: unanswered, kind: "s3" as const },
            },
            hearthId
          )
          const newer = yield* runTask(manager, toBucket(48), hearthId)

          state.away = false
          yield* manager.hearthConnected(hearthId)
          yield* manager.runPending()

          assert.strictEqual(
            (yield* manager.get(older.taskId))?.status,
            "queued"
          )
          assert.strictEqual(
            (yield* manager.get(newer.taskId))?.status,
            "succeeded"
          )
        })
      )
  )

  it.effect(
    "keeps its own copy at once and sends the bucket's when the Hearth is back",
    () =>
      withRelay("kiln-backup-waits-both-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const own = "30000000-0000-4000-8000-000000000004"
          const { options, state } = comesAndGoes()
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const waiting = yield* runTask(
            manager,
            {
              ...backupInput(43),
              destination: { artifactId: own, kind: "local" as const },
              replicas: [{ artifactId: copy, kind: "s3" as const }],
            },
            hearthId
          )
          assert.strictEqual(waiting.status, "queued")

          state.away = false
          yield* manager.hearthConnected(hearthId)
          yield* manager.runPending()

          const sent = (yield* manager.get(waiting.taskId))!
          assert.strictEqual(sent.status, "succeeded", sent.error ?? "")
          assert.deepStrictEqual(
            archiveResult(sent).artifacts?.map((stored) => [
              stored.artifactId,
              stored.status,
            ]),
            [
              [own, "available"],
              [copy, "available"],
            ]
          )
          // Still the Relay's own copy.
          assert.isTrue(existsSync(archiveOf(config, 43)))
        })
      )
  )

  it.effect("removes what a waiting backup took when it is cancelled", () =>
    withRelay("kiln-backup-waits-cancel-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "world.txt"), "world")
        )
        const manager = yield* backupManager(
          config,
          undefined,
          undefined,
          comesAndGoes().options
        )
        const waiting = yield* runTask(manager, toBucket(44), hearthId)
        assert.isTrue(existsSync(archiveOf(config, 44)))

        const cancelled = yield* manager.cancel(waiting.taskId)

        assert.strictEqual(cancelled?.status, "cancelled")
        assert.isFalse(existsSync(archiveOf(config, 44)))
      })
    )
  )

  // Recorded as cancelled, then the Relay stops before the file is gone.
  it.effect(
    "removes as it starts what a backup cancelled as the Relay stopped had taken",
    () =>
      withRelay("kiln-backup-waits-cancel-stop-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const before = yield* backupManager(
            config,
            undefined,
            undefined,
            comesAndGoes().options
          )
          const waiting = yield* runTask(before, toBucket(50), hearthId)
          const journal = yield* RelayStateStore
          yield* journal.cancelBackupTask(waiting.taskId, Date.now())
          assert.isTrue(existsSync(archiveOf(config, 50)))

          yield* backupManager(config)

          assert.isFalse(existsSync(archiveOf(config, 50)))
        })
      )
  )

  // Cancelled between two copies, a backup used to end as a defect, which
  // stopped the Relay's backup worker until the Relay was restarted.
  it.effect(
    "ends a backup cancelled as it asks to send a copy, and carries on",
    () =>
      withRelay("kiln-backup-bucket-cancel-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          // The backup is held as it asks Hearth for its upload.
          let release = () => {}
          const held = new Promise<void>((resolved) => {
            release = resolved
          })
          const { asked, options } = hearth(async () => {
            await held
            return signed("PUT")
          })
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          // A second copy to go on to, which is where it stopped.
          const create = {
            ...backupInput(35),
            destination: { artifactId: copy, kind: "s3" as const },
            replicas: [
              {
                artifactId: "30000000-0000-4000-8000-000000000005",
                kind: "s3" as const,
              },
            ],
          }
          yield* manager.enqueue(create, hearthId)
          const run = yield* Effect.forkChild(manager.runPending())
          while (asked.length === 0) {
            yield* Effect.promise(() => yieldToEventLoop())
          }

          yield* manager.cancel(create.taskId)
          release()
          yield* Fiber.join(run)

          const journal = yield* RelayStateStore
          assert.strictEqual(
            (yield* journal.getBackupTask(create.taskId))?.status,
            "cancelled"
          )
          assert.isFalse(existsSync(archiveOf(config, 35)))
          // The worker is still there for the next one.
          const next = yield* runTask(manager, backupInput(36))
          assert.strictEqual(next.status, "succeeded")
        })
      )
  )

  // A Hearth that stays away mustn't fill the Relay's disk.
  it.effect(
    "fails the bucket's copy when no more may wait for that Hearth",
    () =>
      withRelay("kiln-backup-waits-full-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const manager = yield* backupManager(
            { ...config, backupOutboxBytes: 0 },
            undefined,
            undefined,
            comesAndGoes().options
          )

          const task = yield* runTask(manager, toBucket(45), hearthId)

          assert.strictEqual(task.status, "failed")
          assert.include(task.error ?? "", "KILN_RELAY_BACKUP_OUTBOX")
          assert.isFalse(existsSync(archiveOf(config, 45)))
        })
      )
  )
})

describe("Relay archive restores", () => {
  // A server keeps the recipe it was made from, named by a checksum of how
  // it is stored. One made while recipes were kiln.brick/v1 has a v1 file.
  it.effect.each([
    {
      recipe: "its recipe",
      record: (config: RelayConfig) =>
        new BrickCatalog(
          config.brickCatalogUrl,
          config.dataDirectory
        ).saveSnapshot(testBrickRecipe()),
      restored: testBrickRecipe(),
    },
    {
      recipe: "a kiln.brick/v1 recipe, under the checksum the server names",
      record: async (config: RelayConfig) => {
        const content = JSON.stringify(testBrickRecipeV1())
        const checksum = sha256(Buffer.from(content))
        const directory = brickSnapshotDirectory(config.dataDirectory)
        await mkdir(directory, { recursive: true })
        await writeFile(resolve(directory, `${checksum}.json`), content)
        return checksum
      },
      restored: brickRecipeFromV1(testBrickRecipeV1()),
    },
  ])("restores a verified archive, and $recipe", ({ record, restored: recipe }) =>
    withRelay("kiln-backup-restore-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "server.txt"), "old")
        )
        const instance = testInstance({
          brickSource: "https://kiln.test/bricks/paper.yml",
          brickSnapshotSha256: yield* Effect.promise(() => record(config)),
        })
        const manager = yield* backupManager(config, async () => instance)
        const input = backupInput(6)
        const created = archiveResult(yield* runTask(manager, input))
        yield* Effect.sync(() =>
          rmSync(brickSnapshotDirectory(config.dataDirectory), {
            force: true,
            recursive: true,
          })
        )
        yield* Effect.promise(() =>
          Promise.all([
            writeFile(resolve(root, "server.txt"), "new"),
            writeFile(resolve(root, "extra.txt"), "remove"),
          ])
        )

        const restored = yield* runTask(manager, {
          backupId: input.backupId,
          kind: "restore",
          source: {
            bytes: created.bytes,
            checksumSha256: created.checksumSha256,
            kind: "local",
          },
          target: { id: "instance-1", kind: "instance" },
          taskId: "20000000-0000-4000-8000-000000000006",
        })

        assert.strictEqual(restored.status, "succeeded")
        assert.deepStrictEqual(restored.result, { warnings: [] })
        assert.strictEqual(
          yield* Effect.promise(() =>
            readFile(resolve(root, "server.txt"), "utf8")
          ),
          "old"
        )
        const entries = yield* Effect.promise(() => readdir(root))
        assert.notInclude(entries, "extra.txt")
        assert.notInclude(entries, ".kiln-backup")
        assert.deepStrictEqual(
          yield* Effect.promise(() =>
            new BrickCatalog(
              config.brickCatalogUrl,
              config.dataDirectory
            ).recipe(instance.brickSource ?? "", instance.brickSnapshotSha256)
          ),
          recipe
        )
      })
    )
  )

  it.effect("finishes a journaled directory swap after Relay restart", () =>
    Effect.gen(function* () {
      const directory = yield* scratchDirectory("kiln-backup-recovery-")
      const config = testRelayConfig(directory)
      const taskId = "20000000-0000-4000-8000-000000000007"
      const parent = resolve(directory, "instances")
      const staging = resolve(parent, `.instance-1.kiln-restore-${taskId}`)
      const rollback = resolve(parent, `.instance-1.kiln-rollback-${taskId}`)
      const journals = resolve(directory, "restores")
      yield* Effect.promise(async () => {
        await Promise.all([
          mkdir(staging, { recursive: true }),
          mkdir(rollback, { recursive: true }),
          mkdir(journals, { recursive: true }),
        ])
        await Promise.all([
          writeFile(resolve(staging, "server.txt"), "restored"),
          writeFile(resolve(rollback, "server.txt"), "original"),
          writeFile(
            resolve(journals, `${taskId}.json`),
            JSON.stringify({
              instanceDirectory: "instance-1",
              phase: "moved_original",
              taskId,
              version: 1,
            })
          ),
        ])
      })

      assert.deepStrictEqual(
        yield* Effect.promise(() => recoverInterruptedRestores(config)),
        [taskId]
      )
      assert.strictEqual(
        yield* Effect.promise(() =>
          readFile(resolve(parent, "instance-1", "server.txt"), "utf8")
        ),
        "restored"
      )
      assert.notInclude(
        yield* Effect.promise(() => readdir(parent)),
        `.instance-1.kiln-rollback-${taskId}`
      )
    })
  )

  it.effect("rejects archive paths that escape the restore staging root", () =>
    Effect.gen(function* () {
      const directory = yield* scratchDirectory("kiln-backup-traversal-")
      const config = testRelayConfig(directory)
      const input = backupInput(8)
      const archivePath = backupArchivePath(config, input.backupId)
      yield* Effect.promise(async () => {
        await Promise.all([
          mkdir(resolve(config.rootDirectory, "instance-1"), {
            recursive: true,
          }),
          mkdir(resolve(directory, "backups"), { recursive: true }),
        ])
        await writeTestArchive(archivePath, "safe123.txt")
        await replaceArchiveEntryName(archivePath, "safe123.txt", "../evil.txt")
      })
      const archive = yield* Effect.promise(() => readFile(archivePath))

      const restored = yield* Effect.exit(
        Effect.tryPromise(() =>
          restorePortableInstanceBackup(
            config,
            {
              backupId: input.backupId,
              kind: "restore",
              source: {
                bytes: archive.byteLength,
                checksumSha256: sha256(archive),
                kind: "local",
              },
              target: input.target,
              taskId: "20000000-0000-4000-8000-000000000008",
            },
            testInstance(),
            () => undefined,
            noBucket
          )
        )
      )

      assert.isTrue(Exit.isFailure(restored))
      assert.isFalse(existsSync(resolve(directory, "evil.txt")))
      assert.isFalse(existsSync(resolve(config.rootDirectory, "evil.txt")))
    })
  )
})

describe("Relay backup exports", () => {
  // The Relay makes its backup worker in one fiber, which then ends, and
  // runs it in another. A timer started as it's made ends with the first.
  it.effect(
    "sweeps a download that expires while the Relay runs, not only as it starts",
    () =>
      withRelay("kiln-backup-export-sweep-", ({ config }) =>
        Effect.gen(function* () {
          const manager = yield* Fiber.join(
            yield* Effect.forkChild(backupManager(config))
          )
          const worker = yield* Effect.forkChild(manager.run())
          const exports = resolve(config.dataDirectory, "exports")
          const download = resolve(exports, "download.zip")
          yield* Effect.promise(async () => {
            await writeFile(download, "archive")
            await writeFile(resolve(exports, ".download.zip.expires"), "1")
          })

          yield* TestClock.adjust("1 hour")
          // The sweep's file work takes turns of the event loop, not time.
          while (existsSync(download)) {
            yield* Effect.promise(() => yieldToEventLoop())
          }
          yield* Fiber.interrupt(worker)

          assert.isFalse(existsSync(download))
        })
      )
  )
})

function withRelay<A, E>(
  prefix: string,
  body: (context: {
    config: RelayConfig
    root: string
  }) => Effect.Effect<A, E, RelayStateStore | Scope.Scope>
) {
  return Effect.gen(function* () {
    const directory = yield* scratchDirectory(prefix)
    const config = testRelayConfig(directory)
    const root = resolve(config.rootDirectory, "instance-1")
    yield* Effect.promise(() => mkdir(root, { recursive: true }))
    return yield* body({ config, root }).pipe(
      Effect.provide(makeRelayStateLayer(join(directory, "relay.sqlite")))
    )
  })
}

function scratchDirectory(prefix: string) {
  return Effect.acquireRelease(
    Effect.promise(() => mkdtemp(join(tmpdir(), prefix))),
    (directory) =>
      Effect.promise(() => rm(directory, { force: true, recursive: true }))
  )
}

function backupManager(
  config: RelayConfig,
  findInstance: () => Promise<RelayInstanceConfig | null> = async () =>
    testInstance(),
  lanes = new OperationLanes(),
  hearth: Pick<
    Parameters<typeof BackupManager.make>[0],
    "storage"
  > = noHearth
) {
  return BackupManager.make({
    ...hearth,
    config,
    findInstance,
    isInstanceStopped: async () => true,
    lanes,
  })
}

function runTask(
  manager: BackupManager,
  input: BackupTaskInput,
  hearth: string | null = null
) {
  return Effect.gen(function* () {
    yield* manager.enqueue(input, hearth)
    yield* manager.runPending()
    const task = yield* manager.get(input.taskId)
    assert.isNotNull(task)
    return task!
  })
}

function archiveResult(task: RelayBackupTask): BackupArchiveCreateTaskResult {
  const result = task.result
  assert.isTrue(
    result !== null && "filename" in result && !("expiresAt" in result)
  )
  return result as BackupArchiveCreateTaskResult
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

function testBrickRecipe() {
  return brickRecipeSchema.parse({
    format: "kiln.brick/v2",
    kind: "game-server",
    type: "minecraft",
    metadata: {
      author: "Kiln",
      id: "paper",
      name: "Paper",
      summary: "Paper test recipe",
    },
    deploy: {
      type: "image",
      image: "example.test/paper:latest",
      runtime: "Paper",
      memory: "4G",
      pids: 128,
      volumes: ["/server"],
      ports: [{ name: "game", port: 25_565 }],
    },
    "game-server": { game: "Minecraft", srv: true },
  })
}

// The same recipe as a Relay stored it before recipes covered every kind.
function testBrickRecipeV1() {
  return brickRecipeV1Schema.parse({
    format: "kiln.brick/v1",
    metadata: {
      author: "Kiln",
      description: "Paper test recipe",
      game: "Minecraft",
      id: "paper",
      name: "Paper",
    },
    variables: {},
    runtime: {
      environment: {},
      image: "example.test/paper:latest",
      name: "Paper",
      resources: { memory: "4G", pids: 128 },
      storage: { mount: "/server" },
    },
    network: {
      mode: "minecraft-backend",
      ports: [{ container: 25_565, name: "game", protocol: "tcp" }],
      primaryPort: "game",
      supportsSrv: true,
    },
  })
}

function writeTestArchive(path: string, name: string): Promise<void> {
  return new Promise((resolveArchive, rejectArchive) => {
    const archive = new ZipStream({ forceZip64: true })
    const output = createWriteStream(path, { flags: "wx", mode: 0o600 })
    archive.once("error", rejectArchive)
    output.once("error", rejectArchive)
    output.once("close", resolveArchive)
    archive.pipe(output)
    archive.entry(Buffer.from("unsafe"), { name }, (cause) => {
      if (cause) rejectArchive(cause)
      else archive.finalize()
    })
  })
}

async function replaceArchiveEntryName(
  path: string,
  original: string,
  replacement: string
): Promise<void> {
  assert.strictEqual(original.length, replacement.length)
  const archive = await readFile(path)
  const source = Buffer.from(original)
  const target = Buffer.from(replacement)
  let replacements = 0
  for (let offset = archive.indexOf(source); offset !== -1;) {
    target.copy(archive, offset)
    replacements += 1
    offset = archive.indexOf(source, offset + target.length)
  }
  assert.isAtLeast(replacements, 2)
  await writeFile(path, archive)
}

function backupInput(
  index: number
): BackupCreateTaskInput & { kind: "create" } {
  const suffix = String(index).padStart(12, "0")
  return {
    artifactKind: "archive",
    backupId: `00000000-0000-4000-8000-${suffix}`,
    destination: { kind: "local" },
    exclude: [],
    kind: "create",
    maxBytes: 100 * 1024 * 1024,
    mode: "full",
    reason: "manual",
    target: { id: "instance-1", kind: "instance" },
    taskId: `10000000-0000-4000-8000-${suffix}`,
  }
}
