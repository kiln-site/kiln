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
import { Deferred, Effect, Exit, Fiber, type Scope } from "effect"
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
import { backupArchivePath } from "./backups/destinations/index.js"
import { backupStorageAccessThrough } from "./backups/storage-access.js"
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
  // Told as an upload has arrived whole; while it answers false the bucket
  // never answers that upload, as when the Relay is stopped mid-send.
  received: (): boolean => true,
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
      if (options.method === "PUT") {
        if (!bucket.received()) return
        bucket.object = Buffer.concat(sent)
      }
      const response = Object.assign(new PassThrough(), { statusCode: 200 })
      respond(response)
      response.end(options.method === "GET" ? bucket.object : undefined)
    })
    return Object.assign(body, { setTimeout: () => body })
  }
  return { ...https, default: { ...https, request }, request }
})

describe("Relay archive restores", () => {
  it.effect(
    "restores an archive kept only in a bucket, with the one request Hearth signed for it",
    () =>
      withRelay("kiln-backup-bucket-restore-", ({ config, root }) =>
        Effect.gen(function* () {
          const file = resolve(root, "world.txt")
          yield* Effect.promise(() => writeFile(file, "as backed up"))
          const artifactId = "30000000-0000-4000-8000-000000000003"
          const grant = {
            allowPrivateNetwork: false,
            headers: { "x-amz-expected-bucket-owner": "kiln" },
            method: "GET" as const,
            status: "granted" as const,
            url: "https://kiln-backups.s3.example.com/team/backup.zip?X-Amz-Signature=abc",
          }
          const asked: Array<unknown> = []
          const manager = yield* backupManager(config, undefined, undefined, {
            connectedHearths: () => [],
            storage: backupStorageAccessThrough(async (request) => {
              asked.push(request)
              return [{ payload: grant }]
            }),
          })
          const create = backupInput(31)
          const taken = archiveResult(yield* runTask(manager, create))
          const archive = backupArchivePath(config, create.backupId)
          // It was sent to a bucket and isn't on the Relay any more.
          bucket.object = yield* Effect.promise(() => readFile(archive))
          yield* Effect.promise(() => rm(archive))
          yield* Effect.promise(() => writeFile(file, "changed since"))

          const restore = {
            backupId: create.backupId,
            kind: "restore" as const,
            source: {
              artifactId,
              bytes: taken.bytes,
              checksumSha256: taken.checksumSha256,
              kind: "remote" as const,
            },
            target: create.target,
            taskId: "20000000-0000-4000-8000-000000000031",
          }
          const restored = yield* runTask(manager, restore)

          assert.strictEqual(restored.status, "succeeded", restored.error ?? "")
          assert.strictEqual(
            yield* Effect.promise(() => readFile(file, "utf8")),
            "as backed up"
          )
          assert.deepStrictEqual(asked, [
            {
              action: "download",
              artifactId,
              backupId: create.backupId,
              taskId: restore.taskId,
            },
          ])
          assert.deepStrictEqual(bucket.asked, [
            { headers: grant.headers, method: "GET", url: grant.url },
          ])
        })
      )
  )

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

// A bucket is opened only by asking the Hearth a backup is for, so one taken
// while that Hearth can't be asked keeps its archive on the Relay until it
// can.
describe("Relay backups held for Hearth", () => {
  const hearthId = "hearth-one"
  const localCopy = "30000000-0000-4000-8000-000000000001"
  const bucketCopy = "30000000-0000-4000-8000-000000000002"
  const toBucket = (index: number) => ({
    ...backupInput(index),
    destination: { artifactId: bucketCopy, kind: "s3" as const },
  })
  const upload = (name: string) => ({
    allowPrivateNetwork: false,
    headers: { "content-type": "application/zip" },
    method: "PUT",
    status: "granted",
    url: `https://kiln-backups.s3.example.com/team/${name}.zip?X-Amz-Signature=abc`,
  })

  // The Hearth these backups are for: away until `answers` is told what it
  // says.
  function hearthAwayThenBack() {
    let said: unknown = null
    return {
      answers: (payload: unknown) => {
        said = payload
      },
      hearth: {
        connectedHearths: () => (said === null ? [] : [hearthId]),
        storage: backupStorageAccessThrough(async (_payload, _timeout, only) =>
          said !== null && only({ id: hearthId, role: "full_access" })
            ? [{ payload: said }]
            : []
        ),
      },
    }
  }

  it.effect(
    "keeps the archive across a restart and stores it as it was taken once Hearth answers",
    () =>
      withRelay("kiln-backup-held-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "as taken")
          )
          const { answers, hearth } = hearthAwayThenBack()
          const input = {
            ...backupInput(21),
            destination: { artifactId: localCopy, kind: "local" as const },
            replicas: [{ artifactId: bucketCopy, kind: "s3" as const }],
          }
          const held = yield* runTask(
            yield* backupManager(config, undefined, undefined, hearth),
            input,
            hearthId
          )
          assert.strictEqual(held.status, "queued")
          assert.isTrue(held.heldForHearth)
          const archive = backupArchivePath(config, input.backupId)
          const taken = sha256(yield* Effect.promise(() => readFile(archive)))

          // What it backed up changes, and the Relay restarts, before
          // Hearth is back.
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "changed since")
          )
          const restarted = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          yield* restarted.runPending()
          assert.isTrue((yield* restarted.get(input.taskId))?.heldForHearth)

          // Hearth is back and signs the upload: the bucket gets the
          // archive of what was there when the backup was taken.
          bucket.asked.length = 0
          answers(upload("held"))
          yield* restarted.hearthReachable(hearthId)
          yield* restarted.runPending()
          const stored = yield* restarted.get(input.taskId)
          assert.strictEqual(stored?.status, "succeeded", stored?.error ?? "")
          assert.isFalse(stored?.heldForHearth)
          const result = archiveResult(stored!)
          assert.strictEqual(result.checksumSha256, taken)
          assert.deepStrictEqual(
            result.artifacts?.map(({ artifactId, status }) => ({
              artifactId,
              status,
            })),
            [
              { artifactId: localCopy, status: "available" },
              { artifactId: bucketCopy, status: "available" },
            ]
          )
          assert.deepStrictEqual(
            bucket.asked.map(({ method, url }) => ({ method, url })),
            [{ method: "PUT", url: upload("held").url }]
          )
          assert.strictEqual(sha256(bucket.object), taken)
          // The Relay's own disk is one of the backup's copies.
          assert.isTrue(existsSync(archive))
        })
      )
  )

  // The archive is in the bucket and the Relay stops before it has said
  // so. What it finds on starting is a held backup, to send again: with
  // the archive gone by then it could only fail a backup that was stored.
  it.effect(
    "sends a held archive again when the Relay stopped after sending it, before recording that",
    () =>
      withRelay("kiln-backup-held-crash-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const { answers, hearth } = hearthAwayThenBack()
          const input = toBucket(25)
          yield* runTask(
            yield* backupManager(config, undefined, undefined, hearth),
            input,
            hearthId
          )
          const archive = backupArchivePath(config, input.backupId)
          const taken = sha256(yield* Effect.promise(() => readFile(archive)))
          const store = yield* RelayStateStore
          yield* store.releaseBackupTasksHeldForHearth(Date.now(), hearthId)
          assert.strictEqual(
            (yield* store.claimNextBackupTask(Date.now()))?.taskId,
            input.taskId
          )

          answers(upload("crash"))
          const restarted = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          yield* restarted.runPending()

          const stored = yield* restarted.get(input.taskId)
          assert.strictEqual(stored?.status, "succeeded", stored?.error ?? "")
          assert.strictEqual(sha256(bucket.object), taken)
          // In the bucket and recorded, so the Relay keeps none of it.
          assert.isFalse(existsSync(archive))
          assert.isNull(yield* store.heldBackupArchive(input.taskId))
        })
      )
  )

  it.effect(
    "keeps a held archive when the Relay is stopped while sending it, and sends it once it's back",
    () =>
      withRelay("kiln-backup-held-stopped-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const { answers, hearth } = hearthAwayThenBack()
          const input = toBucket(29)
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          yield* runTask(manager, input, hearthId)
          const archive = backupArchivePath(config, input.backupId)
          const taken = sha256(yield* Effect.promise(() => readFile(archive)))

          // The bucket has the whole upload and the Relay is stopped before
          // it hears so.
          const arrived = yield* Deferred.make<void>()
          bucket.received = () => {
            Deferred.doneUnsafe(arrived, Effect.void)
            return false
          }
          answers(upload("stopped"))
          yield* manager.hearthReachable(hearthId)
          const sending = yield* Effect.forkChild(manager.runPending())
          yield* Deferred.await(arrived)
          yield* Fiber.interrupt(sending)
          assert.isTrue(existsSync(archive))

          bucket.received = () => true
          const restarted = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          yield* restarted.runPending()
          const stored = yield* restarted.get(input.taskId)
          assert.strictEqual(stored?.status, "succeeded", stored?.error ?? "")
          assert.strictEqual(sha256(bucket.object), taken)
          assert.isFalse(existsSync(archive))
        })
      )
  )

  it.effect(
    "asks only the Hearth a backup is for, and stays held while another is the one connected",
    () =>
      withRelay("kiln-backup-held-other-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const { answers, hearth } = hearthAwayThenBack()
          // `hearth-one` is connected and would sign anything.
          answers(upload("elsewhere"))
          bucket.asked.length = 0
          const input = toBucket(28)
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          const held = yield* runTask(manager, input, "hearth-two")
          assert.isTrue(held.heldForHearth)

          yield* manager.hearthReachable(hearthId)
          yield* manager.runPending()
          assert.isTrue((yield* manager.get(input.taskId))?.heldForHearth)
          assert.deepStrictEqual(bucket.asked, [])
        })
      )
  )

  it.effect(
    "fails a backup past what it may hold, keeping no archive of it",
    () =>
      withRelay("kiln-backup-held-full-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const input = toBucket(22)
          const task = yield* runTask(
            yield* backupManager(
              { ...config, backupOutboxBytes: 1 },
              undefined,
              undefined,
              hearthAwayThenBack().hearth
            ),
            input,
            hearthId
          )
          assert.strictEqual(task.status, "failed")
          assert.isFalse(task.heldForHearth)
          assert.include(task.error ?? "", "already holds as many backups")
          assert.isFalse(existsSync(backupArchivePath(config, input.backupId)))
        })
      )
  )

  // Its Hearth connected and still couldn't answer, so the held backup had
  // its turn and is held again. Its archive never left the Relay: it counts
  // against what the Relay may hold throughout, and isn't the one refused.
  it.effect(
    "counts a held archive until its backup ends, and never refuses the one already held",
    () =>
      withRelay("kiln-backup-held-count-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const { hearth } = hearthAwayThenBack()
          const first = toBucket(26)
          yield* runTask(
            yield* backupManager(config, undefined, undefined, hearth),
            first,
            hearthId
          )
          const held = yield* Effect.promise(() =>
            readFile(backupArchivePath(config, first.backupId))
          )
          // Room for the one it holds, not for another like it.
          const manager = yield* backupManager(
            { ...config, backupOutboxBytes: held.byteLength + 16 },
            undefined,
            undefined,
            hearth
          )
          yield* manager.hearthReachable(hearthId)
          const second = toBucket(27)
          const refused = yield* runTask(manager, second, hearthId)

          assert.isTrue((yield* manager.get(first.taskId))?.heldForHearth)
          assert.isTrue(existsSync(backupArchivePath(config, first.backupId)))
          assert.strictEqual(refused.status, "failed")
          assert.include(refused.error ?? "", "already holds as many backups")
          assert.isFalse(existsSync(backupArchivePath(config, second.backupId)))
        })
      )
  )

  it.effect(
    "drops the archive of a held backup that's cancelled, and sends nothing when Hearth is back",
    () =>
      withRelay("kiln-backup-held-cancel-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const { answers, hearth } = hearthAwayThenBack()
          const input = toBucket(23)
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          assert.isTrue((yield* runTask(manager, input, hearthId)).heldForHearth)
          const archive = backupArchivePath(config, input.backupId)
          assert.isTrue(existsSync(archive))

          assert.strictEqual(
            (yield* manager.cancel(input.taskId))?.status,
            "cancelled"
          )
          assert.isFalse(existsSync(archive))
          bucket.asked.length = 0
          answers(upload("cancelled"))
          yield* manager.hearthReachable(hearthId)
          yield* manager.runPending()
          assert.strictEqual(
            (yield* manager.get(input.taskId))?.status,
            "cancelled"
          )
          assert.deepStrictEqual(bucket.asked, [])
        })
      )
  )

  // Its Hearth is connected and can't say yet, as while it still owes the
  // Relay the schedule that allows the backup. Nothing reconnects when it
  // can, so the worker has to ask again on its own.
  it.effect(
    "asks again by itself, a minute on, when its connected Hearth said to ask later",
    () =>
      withRelay("kiln-backup-later-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const { answers, hearth } = hearthAwayThenBack()
          answers({ reason: "a schedule is owed", status: "later" })
          const input = toBucket(28)
          // Made in a fiber of its own that then ends, as the Relay makes
          // it when it starts: a timer forked there would end with it.
          const manager = yield* Fiber.join(
            yield* Effect.forkChild(
              backupManager(config, undefined, undefined, hearth)
            )
          )
          const worker = yield* Effect.forkChild(manager.run())
          // The worker runs on its own: its file and bucket work takes
          // turns of the event loop, not time.
          const settled = (done: (task: RelayBackupTask) => boolean) =>
            Effect.gen(function* () {
              while (true) {
                const task = yield* manager.get(input.taskId)
                if (task && done(task)) return task
                yield* Effect.promise(() => yieldToEventLoop())
              }
            })
          yield* manager.enqueue(input, hearthId)
          yield* settled((task) => task.heldForHearth)

          bucket.asked.length = 0
          answers(upload("later"))
          yield* TestClock.adjust("1 minute")
          const stored = yield* settled((task) => task.finishedAt !== null)
          yield* Fiber.interrupt(worker)

          assert.strictEqual(stored.status, "succeeded", stored.error ?? "")
          assert.deepStrictEqual(
            bucket.asked.map(({ method }) => method),
            ["PUT"]
          )
        })
      )
  )

  // One bucket has the archive when Hearth goes away before the other can
  // be asked for. By the time Hearth is back the first is turned off, and
  // would be refused: what it already holds still counts.
  it.effect(
    "keeps the copies a held backup already stored, and sends only the rest when Hearth is back",
    () =>
      withRelay("kiln-backup-held-partial-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const first = "30000000-0000-4000-8000-000000000011"
          const second = "30000000-0000-4000-8000-000000000012"
          const says = new Map<string, unknown>([[first, upload("first")]])
          const asked: Array<string> = []
          const hearth = {
            connectedHearths: () => [hearthId],
            storage: backupStorageAccessThrough(async (payload) => {
              asked.push(payload.artifactId)
              const answer = says.get(payload.artifactId)
              return answer === undefined ? [] : [{ payload: answer }]
            }),
          }
          const input = {
            ...backupInput(29),
            destination: { artifactId: first, kind: "s3" as const },
            replicas: [{ artifactId: second, kind: "s3" as const }],
          }
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          const held = yield* runTask(manager, input, hearthId)
          assert.isTrue(held.heldForHearth)

          asked.length = 0
          says.set(first, { reason: "it is disabled", status: "refused" })
          says.set(second, upload("second"))
          yield* manager.hearthReachable(hearthId)
          yield* manager.runPending()

          const stored = yield* manager.get(input.taskId)
          assert.strictEqual(stored?.status, "succeeded", stored?.error ?? "")
          assert.deepStrictEqual(
            archiveResult(stored!).artifacts?.map(({ artifactId, status }) => ({
              artifactId,
              status,
            })),
            [
              { artifactId: first, status: "available" },
              { artifactId: second, status: "available" },
            ]
          )
          assert.deepStrictEqual(asked, [second])
        })
      )
  )

  // The bucket has dropped the object and the Relay stops before it says
  // so. It starts again with Hearth not yet connected. Recording the copy
  // as not deleted then would leave Hearth listing a backup that's gone.
  it.effect(
    "leaves a delete waiting while Hearth can't be asked, and deletes once it can",
    () =>
      withRelay("kiln-backup-delete-wait-", ({ config }) =>
        Effect.gen(function* () {
          const { answers, hearth } = hearthAwayThenBack()
          const input = {
            backupId: "00000000-0000-4000-8000-000000000030",
            destination: { artifactId: bucketCopy, kind: "s3" as const },
            kind: "delete" as const,
            target: backupInput(30).target,
            taskId: "10000000-0000-4000-8000-000000000030",
          }
          const manager = yield* backupManager(
            config,
            undefined,
            undefined,
            hearth
          )
          const waiting = yield* runTask(manager, input, hearthId)
          assert.strictEqual(waiting.status, "queued")
          assert.isTrue(waiting.heldForHearth)
          assert.isNull(waiting.result)

          bucket.asked.length = 0
          answers({
            allowPrivateNetwork: false,
            headers: {},
            method: "DELETE",
            status: "granted",
            url: "https://kiln-backups.s3.example.com/team/gone.zip?X-Amz-Signature=abc",
          })
          yield* manager.hearthReachable(hearthId)
          yield* manager.runPending()

          const deleted = yield* manager.get(input.taskId)
          assert.strictEqual(deleted?.status, "succeeded", deleted?.error ?? "")
          assert.deepStrictEqual(
            deleted?.result && "artifacts" in deleted.result
              ? deleted.result.artifacts
              : null,
            [{ artifactId: bucketCopy, error: null, status: "deleted" }]
          )
          assert.deepStrictEqual(
            bucket.asked.map(({ method }) => method),
            ["DELETE"]
          )
        })
      )
  )

  it.effect(
    "fails a backup its Hearth refuses a bucket to, without holding it",
    () =>
      withRelay("kiln-backup-refused-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(() =>
            writeFile(resolve(root, "world.txt"), "world")
          )
          const { answers, hearth } = hearthAwayThenBack()
          answers({ reason: "the task has ended", status: "refused" })
          const input = toBucket(24)
          const task = yield* runTask(
            yield* backupManager(config, undefined, undefined, hearth),
            input,
            hearthId
          )
          assert.strictEqual(task.status, "failed")
          assert.isFalse(task.heldForHearth)
          assert.include(task.error ?? "", "the task has ended")
          assert.isFalse(existsSync(backupArchivePath(config, input.backupId)))
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
    "connectedHearths" | "storage"
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
