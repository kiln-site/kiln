import { createHash } from "node:crypto"
import { createWriteStream, existsSync, rmSync } from "node:fs"
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { assert, describe, it } from "@effect/vitest"
import { Effect, Exit, type Scope } from "effect"
import ZipStream from "zip-stream"

import type {
  BackupArchiveCreateTaskResult,
  BackupCreateTaskInput,
  BackupTaskInput,
  RelayBackupTask,
} from "@workspace/contracts"
import { brickRecipeSchema } from "@workspace/contracts"

import {
  recoverInterruptedRestores,
  restorePortableInstanceBackup,
} from "./backup-restore.js"
import { BackupManager } from "./backups.js"
import { backupArchivePath } from "./backups/destinations/index.js"
import { BrickCatalog, brickSnapshotDirectory } from "./bricks.js"
import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import { testInstance, testRelayConfig } from "./test/fixtures.js"
import { OperationLanes } from "./operation-lanes.js"

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
            testInstance(),
            () => undefined
          )
        )
      )

      assert.isTrue(Exit.isFailure(restored))
      assert.isFalse(existsSync(resolve(directory, "evil.txt")))
      assert.isFalse(existsSync(resolve(config.rootDirectory, "evil.txt")))
    })
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
  lanes = new OperationLanes()
) {
  return BackupManager.make({
    config,
    findInstance,
    isInstanceStopped: async () => true,
    lanes,
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

function sha256(contents: Buffer): string {
  return createHash("sha256").update(contents).digest("hex")
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
