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
import {
  backupCopySettledThrough,
  backupStorageAccessThrough,
} from "./backups/storage-access.js"
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

// The Relay holds no keys to a bucket. A backup's task ends once its archive
// is taken; each copy for a bucket waits in the spool, and is sent with the
// one request the Hearth its task came from signs for it.
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
  const signsEverything = (action: string) =>
    signed(
      action === "upload" ? "PUT" : action === "download" ? "GET" : "DELETE"
    )
  // The Hearth these tasks came from: what it answers each request for
  // access, and what it was told of copies sent. `away` is it not answering.
  const hearth = (answer: (action: string) => unknown = signsEverything) => {
    const asked: Array<unknown> = []
    const told: Array<unknown> = []
    const state = {
      answer,
      away: false,
      /** It signs requests, but what it is told of a copy doesn't arrive. */
      deaf: false,
    }
    return {
      asked,
      options: {
        settled: backupCopySettledThrough(async (report, _timeout, only) => {
          if (
            state.away ||
            state.deaf ||
            !only({ id: hearthId, role: "full_access" })
          ) {
            return []
          }
          told.push(report)
          return [{ payload: { status: "recorded" } }]
        }),
        storage: backupStorageAccessThrough(async (request, _timeout, only) => {
          if (state.away || !only({ id: hearthId, role: "full_access" })) {
            return []
          }
          asked.push(request)
          return [{ payload: state.answer(request.action) }]
        }),
      },
      state,
      told,
    }
  }
  const toBucket = (index: number) => ({
    ...backupInput(index),
    destination: { artifactId: copy, kind: "s3" as const },
  })
  const spooled = (config: RelayConfig) =>
    resolve(config.dataDirectory, "backup-spool", `${copy}.zip`)
  const world = (root: string, contents: string) =>
    Effect.promise(() => writeFile(resolve(root, "world.txt"), contents))

  it.effect(
    "ends the backup once the archive is taken, then sends, reads back and deletes it with one signed request each",
    () =>
      withRelay("kiln-backup-bucket-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* world(root, "as backed up")
          bucket.asked.length = 0
          const { asked, options, told } = hearth()
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const create = toBucket(31)
          const taken = yield* runTask(manager, create, hearthId)
          assert.strictEqual(taken.status, "succeeded", taken.error ?? "")
          const archive = archiveResult(taken)
          // Taken, and waiting to be sent: nothing has reached the bucket.
          assert.deepStrictEqual(archive.artifacts, [
            { artifactId: copy, error: null, status: "pending" },
          ])
          assert.deepStrictEqual(bucket.asked, [])
          assert.isTrue(existsSync(spooled(config)))

          yield* manager.sendSpooled()
          assert.strictEqual(sha256(bucket.object), archive.checksumSha256)
          assert.deepStrictEqual(told, [
            {
              artifactId: copy,
              error: null,
              errorCode: null,
              status: "available",
            },
          ])
          // Sent and told: the Relay keeps nothing of it.
          assert.isFalse(existsSync(spooled(config)))
          assert.isFalse(
            existsSync(backupArchivePath(config, create.backupId))
          )

          yield* world(root, "changed since")
          const restored = yield* runTask(
            manager,
            {
              backupId: create.backupId,
              kind: "restore" as const,
              source: {
                artifactId: copy,
                bytes: archive.bytes,
                checksumSha256: archive.checksumSha256,
                kind: "remote" as const,
              },
              target: create.target,
              taskId: "20000000-0000-4000-8000-000000000031",
            },
            hearthId
          )
          assert.strictEqual(restored.status, "succeeded", restored.error ?? "")
          assert.strictEqual(
            yield* Effect.promise(() =>
              readFile(resolve(root, "world.txt"), "utf8")
            ),
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

  // Hearth is away as the backup is taken, and the Relay restarts before it
  // is back. What reaches the bucket is the archive as it was taken.
  it.effect(
    "keeps a copy across a restart while Hearth is away, and sends it as it was taken when Hearth is back",
    () =>
      withRelay("kiln-backup-spool-away-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* world(root, "as taken")
          bucket.asked.length = 0
          const { options, state, told } = hearth()
          state.away = true
          const create = toBucket(34)
          const first = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const taken = archiveResult(yield* runTask(first, create, hearthId))
          yield* first.sendSpooled()
          assert.deepStrictEqual(bucket.asked, [])

          yield* world(root, "changed since")
          const restarted = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          state.away = false
          // Its turn comes as its Hearth connects, not a minute on.
          yield* restarted.hearthReachable(hearthId)
          yield* restarted.sendSpooled()

          assert.strictEqual(sha256(bucket.object), taken.checksumSha256)
          assert.deepStrictEqual(
            told.map((report) => (report as { status: string }).status),
            ["available"]
          )
          assert.isFalse(existsSync(spooled(config)))
        })
      )
  )

  it.effect(
    "tells Hearth a copy failed when Hearth refuses it the bucket, and sends it nothing",
    () =>
      withRelay("kiln-backup-spool-refused-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* world(root, "world")
          bucket.asked.length = 0
          const { options, told } = hearth(() => ({
            reason: "the backup destination is unavailable",
            status: "refused",
          }))
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          yield* runTask(manager, toBucket(33), hearthId)
          yield* manager.sendSpooled()

          assert.deepStrictEqual(bucket.asked, [])
          assert.lengthOf(told, 1)
          assert.include(
            (told[0] as { error: string }).error,
            "the backup destination is unavailable"
          )
          assert.strictEqual((told[0] as { status: string }).status, "failed")
          assert.isFalse(existsSync(spooled(config)))
        })
      )
  )

  it.effect("sends nothing of a backup deleted while its copy waits", () =>
    withRelay("kiln-backup-spool-deleted-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* world(root, "world")
        bucket.asked.length = 0
        const { options, state, told } = hearth()
        state.away = true
        const manager = yield* backupManager(
          config,
          undefined,
          undefined,
          options
        )
        const create = toBucket(35)
        yield* runTask(manager, create, hearthId)
        state.away = false
        yield* runTask(
          manager,
          {
            backupId: create.backupId,
            destination: { artifactId: copy, kind: "s3" as const },
            kind: "delete" as const,
            target: create.target,
            taskId: "10000000-0000-4000-8000-000000000135",
          },
          hearthId
        )
        yield* manager.hearthReachable(hearthId)
        yield* manager.sendSpooled()

        // Only the delete reached the bucket; the copy was never sent.
        assert.deepStrictEqual(
          bucket.asked.map(({ method }) => method),
          ["DELETE"]
        )
        assert.deepStrictEqual(told, [])
        assert.isFalse(existsSync(spooled(config)))
      })
    )
  )

  // Hearth still has the copy as one to come, and only the spool can send
  // it: a delete that couldn't remove it mustn't take it from there.
  it.effect(
    "still sends a waiting copy after a delete that couldn't ask Hearth for it",
    () =>
      withRelay("kiln-backup-spool-delete-failed-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* world(root, "world")
          bucket.asked.length = 0
          const { options, state, told } = hearth()
          state.away = true
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const create = toBucket(36)
          const taken = archiveResult(yield* runTask(manager, create, hearthId))
          const deleted = yield* runTask(
            manager,
            {
              backupId: create.backupId,
              destination: { artifactId: copy, kind: "s3" as const },
              kind: "delete" as const,
              target: create.target,
              taskId: "10000000-0000-4000-8000-000000000136",
            },
            hearthId
          )
          // The delete ended, saying it couldn't remove the bucket's copy.
          assert.notStrictEqual(
            (deleted.result as { artifacts?: Array<{ status: string }> })
              .artifacts?.[0]?.status,
            "deleted"
          )
          assert.deepStrictEqual(bucket.asked, [])
          assert.isTrue(existsSync(spooled(config)))

          state.away = false
          yield* manager.hearthReachable(hearthId)
          yield* manager.sendSpooled()

          assert.strictEqual(sha256(bucket.object), taken.checksumSha256)
          assert.deepStrictEqual(
            told.map((report) => (report as { status: string }).status),
            ["available"]
          )
        })
      )
  )

  // Hearth says not yet while it is deleting the copy's backup, which it
  // may yet keep. Taken as a no, that would cost the only archive.
  it.effect(
    "keeps a copy Hearth won't take yet, and sends it once Hearth will",
    () =>
      withRelay("kiln-backup-spool-later-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* world(root, "world")
          bucket.asked.length = 0
          const { options, state, told } = hearth(() => ({
            reason: "that backup is being deleted",
            status: "later",
          }))
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          const taken = archiveResult(
            yield* runTask(manager, toBucket(38), hearthId)
          )
          yield* manager.sendSpooled()
          assert.deepStrictEqual(bucket.asked, [])
          assert.deepStrictEqual(told, [])
          assert.isTrue(existsSync(spooled(config)))

          state.answer = signsEverything
          yield* manager.hearthReachable(hearthId)
          yield* manager.sendSpooled()
          assert.strictEqual(sha256(bucket.object), taken.checksumSha256)
          assert.deepStrictEqual(
            told.map((report) => (report as { status: string }).status),
            ["available"]
          )
        })
      )
  )

  // Sent, and Hearth yet to hear of it: only the outcome waits. A stop
  // between recording that and giving the archive up mustn't leave it
  // holding room the spool's limit doesn't count.
  it.effect(
    "keeps no archive for a copy that is already sent, across a restart",
    () =>
      withRelay("kiln-backup-spool-settled-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* world(root, "world")
          bucket.asked.length = 0
          const { options, state, told } = hearth()
          state.deaf = true
          const first = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          yield* runTask(first, toBucket(39), hearthId)
          yield* first.sendSpooled()
          assert.deepStrictEqual(
            bucket.asked.map(({ method }) => method),
            ["PUT"]
          )
          assert.isFalse(existsSync(spooled(config)))
          // As a stop left it: recorded as sent, its link still there.
          yield* Effect.promise(() => writeFile(spooled(config), "left over"))

          const restarted = yield* backupManager(
            config,
            undefined,
            undefined,
            options
          )
          assert.isFalse(existsSync(spooled(config)))

          state.deaf = false
          yield* restarted.hearthReachable(hearthId)
          yield* restarted.sendSpooled()
          assert.deepStrictEqual(
            told.map((report) => (report as { status: string }).status),
            ["available"]
          )
        })
      )
  )

  // A Hearth that stays away mustn't fill the Relay's disk.
  it.effect(
    "fails a backup's copy for a bucket once its Hearth's waiting copies take the room they may",
    () =>
      withRelay("kiln-backup-spool-full-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* world(root, "world")
          const { options, state } = hearth()
          state.away = true
          const manager = yield* backupManager(
            { ...config, backupOutboxBytes: 16 },
            undefined,
            undefined,
            options
          )
          const task = yield* runTask(manager, toBucket(36), hearthId)

          assert.strictEqual(task.status, "failed")
          assert.include(task.error ?? "", "waiting to be sent")
          assert.isFalse(existsSync(spooled(config)))
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
  hearth: Partial<
    Pick<Parameters<typeof BackupManager.make>[0], "settled" | "storage">
  > = {}
) {
  return BackupManager.make({
    ...noHearth,
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
