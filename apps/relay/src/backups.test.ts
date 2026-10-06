import { createHash } from "node:crypto"
import {
  chmodSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  watch,
  writeFileSync,
} from "node:fs"
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { delimiter, join, resolve } from "node:path"
import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Exit, Fiber, type Scope } from "effect"
import { TestClock } from "effect/testing"
import { openPromise } from "yauzl"
import ZipStream from "zip-stream"

import type {
  BackupArchiveCreateTaskResult,
  BackupCreateTaskInput,
  BackupTaskInput,
  RelayBackupTask,
} from "@workspace/contracts"
import {
  backupArchiveManifestSchema,
  brickRecipeSchema,
} from "@workspace/contracts"

import {
  recoverInterruptedRestores,
  restorePortableInstanceBackup,
} from "./backup-restore.js"
import { BackupManager } from "./backups.js"
import {
  backupArchivePath,
  resticRepositoryPath,
} from "./backups/destinations/index.js"
import { BrickCatalog, brickSnapshotDirectory } from "./bricks.js"
import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import { testInstance, testRelayConfig } from "./test/fixtures.js"

// Restic is faked at its process boundary: a stateful `restic` executable first
// on PATH keeps each repository's snapshots and stored data in `repos.json`.
const fakeRestic = mkdtempSync(join(tmpdir(), "kiln-fake-restic-"))
const originalPath = process.env.PATH

beforeAll(() => {
  const bin = join(fakeRestic, "bin")
  mkdirSync(bin)
  writeFileSync(join(bin, "restic"), fakeResticScript(fakeRestic))
  chmodSync(join(bin, "restic"), 0o755)
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`
})

afterAll(() => {
  process.env.PATH = originalPath
  rmSync(fakeRestic, { force: true, recursive: true })
})

describe("Relay archive backups", () => {
  it.effect(
    "creates a checksummed archive with server metadata and safe exclusions",
    () =>
      withRelay("kiln-backup-archive-", ({ config, root }) =>
        Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await mkdir(resolve(root, "world"), { recursive: true })
            await mkdir(resolve(root, "logs"), { recursive: true })
            await writeFile(resolve(root, "world", "level.dat"), "level")
            await writeFile(resolve(root, "session.lock"), "lock")
            await writeFile(resolve(root, "logs", "debug.log"), "debug")
            await symlink("level.dat", resolve(root, "world", "latest"))
          })
          const input = { ...backupInput(3), exclude: ["logs/**"] }
          yield* Effect.promise(async () => {
            await mkdir(resolve(config.dataDirectory, "backups"), {
              recursive: true,
            })
            await writeFile(
              resolve(
                config.dataDirectory,
                "backups",
                `.${input.backupId}.stale.partial`
              ),
              "stale"
            )
          })
          const snapshotRecipe = testBrickRecipe()
          const snapshotSha256 = yield* Effect.promise(() =>
            new BrickCatalog(
              config.brickCatalogUrl,
              config.dataDirectory
            ).saveSnapshot(snapshotRecipe)
          )
          const instance = testInstance({
            brickConsoleStopCommands: ["stop"],
            brickFormat: "kiln.brick/v1",
            brickId: "paper",
            brickNetworkMode: "minecraft-backend",
            brickPrimaryPort: 25_565,
            brickPrimaryPortProtocol: "tcp",
            brickReadiness: { logs: ["Done"] },
            brickSource: "https://kiln.test/bricks/paper.yml",
            brickSnapshotSha256: snapshotSha256,
            brickSupportsSrv: true,
            limits: {
              diskBytes: 25 * 1024 ** 3,
              memoryBytes: 4 * 1024 ** 3,
            },
            ports: [
              {
                externalPort: 25_565,
                id: "primary",
                internalPort: 25_565,
                kind: "primary",
                name: "Minecraft",
                protocol: "tcp",
              },
            ],
            publicHost: "play.kiln.test",
            publicPort: 25_565,
            tailscale: { enabled: true, subdomain: "survival" },
            variables: { memory: "4G", online_mode: false },
          })
          const webRoutes = [
            {
              hostname: "map.kiln.test",
              id: "deadbeef",
              name: "Map",
              path: "/world",
              stripPrefix: true,
              targetPort: 8_123,
            },
          ]
          const state = yield* RelayStateStore
          yield* state.replaceInstanceRoutes(instance.id, webRoutes)
          const manager = yield* backupManager(config, async () => instance)

          const task = yield* runTask(manager, input)

          assert.strictEqual(task.status, "succeeded")
          const result = archiveResult(task)
          const archivePath = backupArchivePath(config, input.backupId)
          const archive = yield* Effect.promise(() => readFile(archivePath))
          assert.strictEqual(result.bytes, archive.byteLength)
          assert.strictEqual(result.checksumSha256, sha256(archive))
          const contents = yield* Effect.promise(() => readArchive(archivePath))
          assert.deepStrictEqual([...contents.keys()].sort(), [
            ".kiln-backup/manifest.json",
            "world/level.dat",
          ])
          const manifest = backupArchiveManifestSchema.parse(
            JSON.parse(
              contents.get(".kiln-backup/manifest.json") ?? ""
            ) as unknown
          )
          assert.strictEqual(manifest.formatVersion, 3)
          if (manifest.formatVersion === 3) {
            assert.deepStrictEqual(manifest.server, {
              brick: {
                consoleStopCommands: ["stop"],
                format: "kiln.brick/v1",
                id: "paper",
                networkMode: "minecraft-backend",
                primaryPort: 25_565,
                primaryPortProtocol: "tcp",
                readiness: { logs: ["Done"] },
                recipe: snapshotRecipe,
                snapshotSha256,
                source: "https://kiln.test/bricks/paper.yml",
                supportsSrv: true,
              },
              game: "minecraft",
              implementation: "paper",
              javaVersion: "21",
              name: "Instance One",
              network: {
                connectAddress: "relay.test",
                ports: instance.ports,
                publicHost: "play.kiln.test",
                publicPort: 25_565,
                webRoutes,
              },
              startup: {
                limits: instance.limits,
                tailscale: instance.tailscale,
                variables: instance.variables ?? {},
              },
              version: "1.21.8",
            })
          }
          assert.deepStrictEqual(yield* partialFiles(config), [])
        })
      )
  )

  it.effect("runs queued create tasks to completion", () =>
    withRelay("kiln-backup-queue-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "server.txt"), "data")
        )
        const manager = yield* backupManager(config)
        const first = backupInput(1)
        const second = backupInput(2)
        yield* manager.enqueue(first)
        yield* manager.enqueue(second)
        yield* manager.runPending()

        assert.deepStrictEqual(
          (yield* manager.list()).map((task) => task.status),
          ["succeeded", "succeeded"]
        )
        assert.isTrue(existsSync(backupArchivePath(config, first.backupId)))
        assert.isTrue(existsSync(backupArchivePath(config, second.backupId)))
      })
    )
  )

  it.effect("cancels a queued create task before archive work starts", () =>
    withRelay("kiln-backup-queued-cancel-", ({ config }) =>
      Effect.gen(function* () {
        const manager = yield* backupManager(config)
        const input = backupInput(11)
        yield* manager.enqueue(input)

        const cancelled = yield* manager.cancel(input.taskId)
        yield* manager.runPending()

        assert.strictEqual(cancelled?.status, "cancelled")
        assert.strictEqual(
          (yield* manager.get(input.taskId))?.status,
          "cancelled"
        )
        assert.isFalse(existsSync(backupArchivePath(config, input.backupId)))
      })
    )
  )

  it.effect("cancels a running create task and leaves no archive", () =>
    withRelay("kiln-backup-running-cancel-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "server.txt"), "data")
        )
        const lookup = gate()
        const release = gate()
        const manager = yield* backupManager(config, async () => {
          lookup.open()
          await release.opened
          return testInstance()
        })
        const input = backupInput(9)
        yield* manager.enqueue(input)
        const worker = yield* Effect.forkChild(manager.runPending())
        yield* Effect.promise(() => lookup.opened)

        const cancelled = yield* manager.cancel(input.taskId)
        release.open()
        yield* Fiber.join(worker)

        assert.strictEqual(cancelled?.status, "cancelled")
        assert.strictEqual(
          (yield* manager.get(input.taskId))?.status,
          "cancelled"
        )
        assert.isFalse(existsSync(backupArchivePath(config, input.backupId)))
      })
    )
  )

  it.effect("cancels a create task when it reaches the backup timeout", () =>
    withRelay("kiln-backup-timeout-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "server.txt"), "data")
        )
        const lookup = gate()
        const release = gate()
        const manager = yield* backupManager(
          { ...config, backupTimeoutMs: 10 },
          async () => {
            lookup.open()
            await release.opened
            return testInstance()
          }
        )
        const input = backupInput(12)
        yield* manager.enqueue(input)
        const worker = yield* Effect.forkChild(manager.runPending())
        yield* Effect.promise(() => lookup.opened)

        yield* TestClock.adjust("10 millis")
        release.open()
        yield* Fiber.join(worker)

        const task = yield* manager.get(input.taskId)
        assert.strictEqual(task?.status, "cancelled")
        assert.include(task?.error ?? "", "timeout")
        assert.isFalse(existsSync(backupArchivePath(config, input.backupId)))
      })
    )
  )

  it.effect(
    "aborts an archive mid-stream when cancelled and leaves nothing behind",
    () =>
      withRelay("kiln-backup-stream-cancel-", ({ config, root }) =>
        Effect.gen(function* () {
          // A sparse file takes seconds to archive without using disk space.
          yield* Effect.promise(async () => {
            await writeFile(resolve(root, "world.bin"), "")
            await truncate(resolve(root, "world.bin"), 2 * 1024 ** 3)
          })
          const backups = resolve(config.dataDirectory, "backups")
          yield* Effect.promise(() => mkdir(backups, { recursive: true }))
          const archiving = gate()
          const watcher = watch(backups, (_event, name) => {
            if (name?.endsWith(".partial")) archiving.open()
          })
          yield* Effect.addFinalizer(() => Effect.sync(() => watcher.close()))
          const manager = yield* backupManager(config)
          const input = backupInput(10)
          yield* manager.enqueue(input)
          const worker = yield* Effect.forkChild(manager.runPending())
          yield* Effect.promise(() => archiving.opened)

          yield* manager.cancel(input.taskId)
          yield* Fiber.join(worker)

          assert.strictEqual(
            (yield* manager.get(input.taskId))?.status,
            "cancelled"
          )
          assert.isFalse(existsSync(backupArchivePath(config, input.backupId)))
          assert.deepStrictEqual(yield* partialFiles(config), [])
        })
      )
  )

  it.effect("keeps the local archive when a replica upload fails", () =>
    withRelay("kiln-backup-replica-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "server.txt"), "data")
        )
        const localArtifactId = "30000000-0000-4000-8000-000000000001"
        const remoteArtifactId = "30000000-0000-4000-8000-000000000002"
        const input = {
          ...backupInput(12),
          destination: { artifactId: localArtifactId, kind: "local" },
          replicas: [
            {
              allowPrivateNetwork: true,
              artifactId: remoteArtifactId,
              headers: {},
              kind: "s3",
              objectKey: "backups/test.zip",
              uploadUrl: unreachableStorageUrl,
            },
          ],
        } satisfies BackupCreateTaskInput & { kind: "create" }
        const manager = yield* backupManager(config)

        const task = yield* runTask(manager, input)

        assert.strictEqual(task.status, "succeeded")
        const artifacts = archiveResult(task).artifacts ?? []
        assert.deepStrictEqual(
          artifacts.map(({ artifactId, status }) => ({ artifactId, status })),
          [
            { artifactId: localArtifactId, status: "available" },
            { artifactId: remoteArtifactId, status: "failed" },
          ]
        )
        assert.isString(artifacts[1]?.error)
        assert.isTrue(existsSync(backupArchivePath(config, input.backupId)))
      })
    )
  )

  it.effect(
    "deletes the local artifact and reports every artifact outcome",
    () =>
      withRelay("kiln-backup-delete-", ({ config }) =>
        Effect.gen(function* () {
          const localArtifactId = "31000000-0000-4000-8000-000000000001"
          const remoteArtifactId = "31000000-0000-4000-8000-000000000002"
          const backupId = "31000000-0000-4000-8000-000000000003"
          const archivePath = backupArchivePath(config, backupId)
          yield* Effect.promise(async () => {
            await mkdir(resolve(config.dataDirectory, "backups"), {
              recursive: true,
            })
            await writeFile(archivePath, "zip")
          })
          const manager = yield* backupManager(config)

          const task = yield* runTask(manager, {
            backupId,
            destination: { artifactId: localArtifactId, kind: "local" },
            kind: "delete",
            replicas: [
              {
                allowPrivateNetwork: true,
                artifactId: remoteArtifactId,
                deleteUrl: unreachableStorageUrl,
                headers: {},
                kind: "s3",
                objectKey: "backups/test.zip",
              },
            ],
            target: { id: "instance-1", kind: "instance" },
            taskId: "31000000-0000-4000-8000-000000000004",
          })

          assert.strictEqual(task.status, "succeeded")
          const artifacts =
            task.result && "artifacts" in task.result
              ? task.result.artifacts
              : []
          assert.deepStrictEqual(
            (artifacts ?? []).map(({ artifactId, status }) => ({
              artifactId,
              status,
            })),
            [
              { artifactId: localArtifactId, status: "deleted" },
              { artifactId: remoteArtifactId, status: "failed" },
            ]
          )
          assert.isFalse(existsSync(archivePath))
        })
      )
  )
})

describe("Relay archive restores", () => {
  it.effect("restores a verified archive through a staged directory swap", () =>
    withRelay("kiln-backup-restore-", ({ config, root }) =>
      Effect.gen(function* () {
        yield* Effect.promise(() =>
          writeFile(resolve(root, "server.txt"), "old")
        )
        const subdomain = `${"a".repeat(60)}.${"b".repeat(59)}`
        const instance = testInstance({
          brickSource: "https://kiln.test/bricks/paper.yml",
          brickSnapshotSha256: yield* Effect.promise(() =>
            new BrickCatalog(
              config.brickCatalogUrl,
              config.dataDirectory
            ).saveSnapshot(testBrickRecipe())
          ),
          tailscale: { enabled: true, subdomain },
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
          testBrickRecipe()
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
            testInstance()
          )
        )
      )

      assert.isTrue(Exit.isFailure(restored))
      assert.isFalse(existsSync(resolve(directory, "evil.txt")))
      assert.isFalse(existsSync(resolve(config.rootDirectory, "evil.txt")))
    })
  )
})

describe("Relay restic backups", () => {
  it.effect("records an incremental snapshot in the repository", () =>
    withRelay("kiln-restic-create-", ({ config }) =>
      Effect.gen(function* () {
        useResticScenario({ backup: { outcome: "complete", totalBytes: 10 } })
        const manager = yield* backupManager(config)
        const input = resticCreateInput(100)

        const task = yield* runTask(manager, input)

        assert.strictEqual(task.status, "succeeded")
        const repository = resticRepository(localRepository(config))
        assert.strictEqual(repository.snapshots.length, 1)
        assert.include(
          repository.snapshots[0]?.tags ?? [],
          `task:${input.taskId}`
        )
        assert.deepInclude(task.result ?? {}, {
          snapshotId: repository.snapshots[0]?.id,
        })
      })
    )
  )

  it.effect.each([
    {
      name: "the snapshot summary exceeds the size limit",
      maxBytes: 100,
      scenario: { backup: { outcome: "complete", totalBytes: 500 } },
      seedTaskSnapshot: false,
    },
    {
      name: "a reused task snapshot exceeds the size limit",
      maxBytes: 100,
      scenario: {},
      seedTaskSnapshot: true,
    },
    {
      name: "progress exceeds the size limit after the snapshot was committed",
      maxBytes: 100,
      scenario: { backup: { outcome: "stall", totalBytes: 500 } },
      seedTaskSnapshot: false,
    },
    {
      name: "restic fails after committing the snapshot",
      maxBytes: null,
      scenario: { backup: { outcome: "fail", totalBytes: 10 } },
      seedTaskSnapshot: false,
    },
  ] satisfies Array<{
    maxBytes: number | null
    name: string
    scenario: ResticScenario
    seedTaskSnapshot: boolean
  }>)(
    "leaves no snapshot behind when $name",
    ({ maxBytes, scenario, seedTaskSnapshot }) =>
      withRelay("kiln-restic-orphan-", ({ config }) =>
        Effect.gen(function* () {
          useResticScenario(scenario)
          const input = resticCreateInput(maxBytes)
          if (seedTaskSnapshot) {
            seedResticRepository(localRepository(config), [
              {
                id: "reused001",
                tags: [`task:${input.taskId}`],
                totalSize: 500,
              },
            ])
          }
          const manager = yield* backupManager(config)

          const task = yield* runTask(manager, input)

          assert.strictEqual(task.status, "failed")
          assert.deepStrictEqual(resticRepository(localRepository(config)), {
            data: [],
            initialized: true,
            snapshots: [],
          })
        })
      )
  )

  it.effect(
    "forgets a snapshot that completes after its create was cancelled",
    () =>
      withRelay("kiln-restic-cancelled-", ({ config }) =>
        Effect.gen(function* () {
          useResticScenario({
            backup: { outcome: "finishOnCancel", totalBytes: 10 },
          })
          const committed = gate()
          const server = createServer(() => committed.open())
          yield* Effect.acquireRelease(
            Effect.promise(
              () =>
                new Promise<void>((resolveListen) =>
                  server.listen(join(fakeRestic, "events.sock"), resolveListen)
                )
            ),
            () =>
              Effect.promise(
                () =>
                  new Promise<void>((resolveClose) =>
                    server.close(() => resolveClose())
                  )
              )
          )
          const manager = yield* backupManager(config)
          const input = resticCreateInput(100)
          yield* manager.enqueue(input)
          const worker = yield* Effect.forkChild(manager.runPending())
          yield* Effect.promise(() => committed.opened)

          yield* manager.cancel(input.taskId)
          yield* Fiber.join(worker)

          assert.strictEqual(
            (yield* manager.get(input.taskId))?.status,
            "cancelled"
          )
          assert.deepStrictEqual(resticRepository(localRepository(config)), {
            data: [],
            initialized: true,
            snapshots: [],
          })
        })
      )
  )

  it.effect(
    "exports a snapshot and extends the staged zip while it is valid",
    () =>
      withRelay("kiln-restic-export-", ({ config }) =>
        Effect.gen(function* () {
          useResticScenario({})
          const backupId = "22000000-0000-4000-8000-000000000001"
          seedResticRepository(localRepository(config), [
            { id: "abcdef12", tags: [], totalSize: 3 },
          ])
          const manager = yield* backupManager(config)
          const exportInput = (taskSuffix: string, ttlMs: number) =>
            ({
              backupId,
              kind: "export",
              repository: { kind: "local" },
              repositoryPassword: "secret",
              snapshotId: "abcdef12",
              target: { id: "instance-1", kind: "instance" },
              taskId: `22000000-0000-4000-8000-0000000000${taskSuffix}`,
              ttlMs,
            }) satisfies BackupTaskInput

          const first = yield* runTask(manager, exportInput("11", 60_000))
          const second = yield* runTask(manager, exportInput("12", 120_000))

          assert.strictEqual(first.status, "succeeded")
          assert.strictEqual(second.status, "succeeded")
          const zip = resolve(
            config.dataDirectory,
            "exports",
            `${backupId}.zip`
          )
          const staged = yield* Effect.promise(() => readFile(zip))
          const firstResult = exportResult(first)
          const secondResult = exportResult(second)
          assert.strictEqual(firstResult.bytes, staged.byteLength)
          assert.strictEqual(firstResult.checksumSha256, sha256(staged))
          assert.strictEqual(secondResult.checksumSha256, sha256(staged))
          assert.isAbove(secondResult.expiresAt, firstResult.expiresAt)
          const marker = resolve(
            config.dataDirectory,
            "exports",
            `.${backupId}.zip.expires`
          )
          assert.strictEqual(
            Number(
              (yield* Effect.promise(() => readFile(marker, "utf8"))).trim()
            ),
            secondResult.expiresAt
          )
        })
      )
  )

  it.effect("prunes a forgotten snapshot and removes its staged export", () =>
    withRelay("kiln-restic-forget-", ({ config }) =>
      Effect.gen(function* () {
        useResticScenario({})
        const backupId = "cccccccc-dddd-4eee-8fff-000000000001"
        const taskId = "10000000-0000-4000-8000-000000000099"
        seedResticRepository(localRepository(config), [
          { id: "deadbeef", tags: [], totalSize: 3 },
          { id: "keep0001", tags: [], totalSize: 3 },
        ])
        const exports = resolve(config.dataDirectory, "exports")
        const staged = [
          resolve(exports, `${backupId}.zip`),
          resolve(exports, `.${backupId}.zip.expires`),
          resolve(exports, `.${backupId}.${taskId}.partial`),
        ]
        yield* Effect.promise(async () => {
          await mkdir(exports, { recursive: true })
          await Promise.all(staged.map((path) => writeFile(path, "staged")))
        })
        const manager = yield* backupManager(config)

        const task = yield* runTask(manager, {
          backupId,
          destination: {
            kind: "restic",
            repository: { kind: "local" },
            repositoryPassword: "secret",
            snapshotId: "deadbeef",
          },
          kind: "delete",
          target: { id: "instance-1", kind: "instance" },
          taskId,
        })

        assert.strictEqual(task.status, "succeeded")
        const repository = resticRepository(localRepository(config))
        assert.deepStrictEqual(
          repository.snapshots.map((snapshot) => snapshot.id),
          ["keep0001"]
        )
        assert.deepStrictEqual(repository.data, ["keep0001"])
        for (const path of staged) assert.isFalse(existsSync(path))
      })
    )
  )

  it.effect("forgets every snapshot tagged with a failed create task", () =>
    withRelay("kiln-restic-forget-tag-", ({ config }) =>
      Effect.gen(function* () {
        useResticScenario({})
        const createTaskId = "10000000-0000-4000-8000-000000000088"
        const repository = {
          accessKeyId: "AKIAEXAMPLE",
          allowPrivateNetwork: true,
          bucket: "kiln-backups",
          endpoint: "https://s3.example.com",
          forcePathStyle: true,
          kind: "s3" as const,
          region: "us-east-1",
          repositoryPrefix: "team/repo",
          secretAccessKey: "s3-secret",
        }
        const remote = "s3:https://s3.example.com/kiln-backups/team/repo"
        seedResticRepository(remote, [
          { id: "tagged001", tags: [`task:${createTaskId}`], totalSize: 3 },
          { id: "other0001", tags: ["task:another"], totalSize: 3 },
        ])
        const manager = yield* backupManager(config)

        const task = yield* runTask(manager, {
          backupId: "dddddddd-eeee-4fff-8000-000000000001",
          destination: {
            createTaskId,
            kind: "restic",
            repository,
            repositoryPassword: "secret",
          },
          kind: "delete",
          target: { id: "instance-1", kind: "instance" },
          taskId: "10000000-0000-4000-8000-000000000098",
        })

        assert.strictEqual(task.status, "succeeded")
        const stored = resticRepository(remote)
        assert.deepStrictEqual(
          stored.snapshots.map((snapshot) => snapshot.id),
          ["other0001"]
        )
        assert.deepStrictEqual(stored.data, ["other0001"])
      })
    )
  )
})

const unreachableStorageUrl = "https://127.0.0.1:1/backups/test.zip"

type ResticScenario = {
  backup?: {
    outcome: "complete" | "fail" | "finishOnCancel" | "stall"
    totalBytes: number
  }
}

type ResticSnapshot = { id: string; tags: Array<string>; totalSize: number }

type ResticRepositoryState = {
  data: Array<string>
  initialized: boolean
  snapshots: Array<ResticSnapshot>
}

function useResticScenario(scenario: ResticScenario): void {
  writeFileSync(join(fakeRestic, "scenario.json"), JSON.stringify(scenario))
}

function readResticRepositories(): Record<string, ResticRepositoryState> {
  return existsSync(join(fakeRestic, "repos.json"))
    ? (JSON.parse(
        readFileSync(join(fakeRestic, "repos.json"), "utf8")
      ) as Record<string, ResticRepositoryState>)
    : {}
}

function resticRepository(repository: string): ResticRepositoryState {
  const state = readResticRepositories()[repository]
  assert.isDefined(state, `restic repository ${repository} was never used`)
  return state!
}

function seedResticRepository(
  repository: string,
  snapshots: Array<ResticSnapshot>
): void {
  writeFileSync(
    join(fakeRestic, "repos.json"),
    JSON.stringify({
      ...readResticRepositories(),
      [repository]: {
        data: snapshots.map((snapshot) => snapshot.id),
        initialized: true,
        snapshots,
      },
    })
  )
}

function localRepository(config: RelayConfig): string {
  return resticRepositoryPath(config, "instance-1")
}

function fakeResticScript(control: string): string {
  return `#!${process.execPath}
const { randomBytes } = require("node:crypto")
const fs = require("node:fs")
const net = require("node:net")
const path = require("node:path")

const control = ${JSON.stringify(control)}
const reposFile = path.join(control, "repos.json")
const read = (file, fallback) => {
  try { return JSON.parse(fs.readFileSync(file, "utf8")) } catch { return fallback }
}
const repos = read(reposFile, {})
const scenario = read(path.join(control, "scenario.json"), {})
const key = process.env.RESTIC_REPOSITORY
const repo = repos[key] ?? { data: [], initialized: false, snapshots: [] }
const save = () => {
  repos[key] = repo
  fs.writeFileSync(reposFile, JSON.stringify(repos))
}
const print = (value) => fs.writeSync(1, JSON.stringify(value) + "\\n")
const fail = (message, code = 1) => {
  fs.writeSync(2, message + "\\n")
  process.exit(code)
}
const args = []
const argv = process.argv.slice(2)
for (let index = 0; index < argv.length; index += 1) {
  if (argv[index] === "--no-cache") continue
  if (argv[index] === "-o") { index += 1; continue }
  args.push(argv[index])
}
const flags = (name) => args.flatMap((arg, index) => arg === name ? [args[index + 1]] : [])
const find = (id) => repo.snapshots.find((snapshot) => snapshot.id === id)
const requireSnapshot = (id) => find(id) ?? fail('no matching ID found for prefix "' + id + '"')

switch (args[0]) {
  case "unlock":
  case "cache":
    process.exit(0)
  case "cat":
    if (!repo.initialized) fail("Fatal: repository does not exist", 10)
    process.exit(0)
  case "init":
    repo.initialized = true
    save()
    process.exit(0)
  case "snapshots": {
    const tag = flags("--tag")[0]
    print(repo.snapshots.filter((snapshot) => snapshot.tags.includes(tag)))
    process.exit(0)
  }
  case "stats":
    print({ total_size: requireSnapshot(args.at(-1)).totalSize })
    process.exit(0)
  case "forget":
    requireSnapshot(args[1])
    repo.snapshots = repo.snapshots.filter((snapshot) => snapshot.id !== args[1])
    save()
    process.exit(0)
  case "prune":
    repo.data = repo.data.filter((id) => find(id))
    save()
    process.exit(0)
  case "dump":
    fs.writeSync(1, "zip:" + requireSnapshot(args[3].split(":")[0]).id)
    process.exit(0)
  case "backup":
    backup()
    break
  default:
    fail("fake restic does not support " + args[0])
}

function backup() {
  const plan = scenario.backup ?? { outcome: "complete", totalBytes: 10 }
  const id = randomBytes(4).toString("hex")
  repo.snapshots.push({ id, tags: flags("--tag"), totalSize: plan.totalBytes })
  repo.data.push(id)
  save()
  const summary = { message_type: "summary", snapshot_id: id, total_bytes_processed: plan.totalBytes }
  switch (plan.outcome) {
    case "complete":
      print(summary)
      process.exit(0)
    case "fail":
      fail("restic aborted while streams were draining")
    case "stall":
      print({ message_type: "status", bytes_done: 0, total_bytes: plan.totalBytes })
      setInterval(() => undefined, 1 << 30)
      break
    case "finishOnCancel":
      // Finish the snapshot as the Relay terminates the process.
      process.on("SIGTERM", () => {
        print(summary)
        process.exit(0)
      })
      net.connect(path.join(control, "events.sock")).on("error", () => undefined)
      setInterval(() => undefined, 1 << 30)
      break
  }
}
`
}

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
    testInstance()
) {
  return BackupManager.make({
    config,
    findInstance,
    isInstanceStopped: async () => true,
  })
}

function runTask(manager: BackupManager, input: BackupTaskInput) {
  return Effect.gen(function* () {
    yield* manager.enqueue(input)
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

function exportResult(task: RelayBackupTask) {
  const result = task.result
  assert.isTrue(result !== null && "expiresAt" in result)
  return result as Extract<RelayBackupTask["result"], { expiresAt: number }>
}

function partialFiles(config: RelayConfig) {
  return Effect.promise(async () =>
    (await readdir(resolve(config.dataDirectory, "backups"))).filter((name) =>
      name.endsWith(".partial")
    )
  )
}

function gate() {
  let open = () => undefined as void
  const opened = new Promise<void>((resolveGate) => {
    open = resolveGate
  })
  return { open: () => open(), opened }
}

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
}

function resticCreateInput(maxBytes: number | null): BackupCreateTaskInput & {
  kind: "create"
} {
  return {
    artifactKind: "restic_snapshot",
    backupId: "00000000-0000-4000-8000-0000000000aa",
    destination: {
      kind: "restic",
      repository: { kind: "local" },
      repositoryPassword: "secret",
    },
    exclude: [],
    kind: "create",
    maxBytes,
    mode: "incremental",
    reason: "manual",
    target: { id: "instance-1", kind: "instance" },
    taskId: "10000000-0000-4000-8000-0000000000aa",
  }
}

function testBrickRecipe() {
  return brickRecipeSchema.parse({
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

async function readArchive(path: string): Promise<Map<string, string>> {
  const archive = await openPromise(path)
  const contents = new Map<string, string>()
  try {
    for await (const entry of archive.eachEntry()) {
      const chunks: Array<Buffer> = []
      const source = await archive.openReadStreamPromise(entry)
      for await (const chunk of source) chunks.push(Buffer.from(chunk))
      contents.set(entry.fileName, Buffer.concat(chunks).toString("utf8"))
    }
  } finally {
    archive.close()
  }
  return contents
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
