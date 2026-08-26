import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { resolve } from "node:path"
import { buffer as consumeBuffer } from "node:stream/consumers"
import { gzipSync, gunzipSync } from "node:zlib"
import type { FileHandle } from "node:fs/promises"
import { assert, describe, it } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { pack as createTarPack, type Headers as TarHeaders } from "tar-stream"
import { parseSnbt } from "@workspace/contracts"

import { loadConfig } from "./config.js"
import { FilesystemDriver, MAX_TRANSFER_BYTES } from "./files.js"
import { RelayFilesystemError } from "./effect/errors.js"
import { decodeNbt, encodeNbt } from "./nbt.js"
import type { RelayInstanceConfig } from "./config.js"

const describeLinux = process.platform === "linux" ? describe : describe.skip

describe("Relay paged file index", () => {
  it.effect("pages directories and searches every matching path", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          Promise.all(
            Array.from({ length: 600 }, (_, index) =>
              writeFile(
                resolve(
                  root,
                  "world",
                  `match-${index.toString().padStart(3, "0")}.txt`
                ),
                String(index)
              )
            )
          )
        )

        const listed: Array<string> = []
        let directoryCursor: string | undefined
        do {
          const page = yield* driver.directory(instance, {
            ...(directoryCursor ? { cursor: directoryCursor } : {}),
            instanceId: instance.id,
            path: "world/",
          })
          listed.push(...page.entries.map((entry) => entry.path))
          directoryCursor = page.cursor ?? undefined
        } while (directoryCursor)

        assert.lengthOf(listed, 600)
        assert.strictEqual(new Set(listed).size, 600)
        assert.include(listed, "world/match-599.txt")

        const metadata = yield* driver.entry(instance, "world/match-599.txt")
        assert.strictEqual(metadata.kind, "file")
        assert.strictEqual(metadata.path, "world/match-599.txt")
        assert.strictEqual(metadata.size, 3)

        const matches: Array<string> = []
        let searchCursor: string | undefined
        do {
          const page = yield* driver.search(instance, {
            ...(searchCursor ? { cursor: searchCursor } : {}),
            instanceId: instance.id,
            query: "match-",
          })
          matches.push(...page.entries.map((entry) => entry.path))
          searchCursor = page.cursor ?? undefined
        } while (searchCursor)

        assert.deepEqual(new Set(matches), new Set(listed))
      })
    )
  )

  it.effect("caps scan sessions without expiring existing cursors", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          Promise.all(
            Array.from({ length: 128 }, (_, index) =>
              writeFile(resolve(root, "world", `entry-${index}.txt`), "")
            )
          )
        )

        const cursors: Array<string> = []
        for (let index = 0; index < 256; index += 1) {
          const page = yield* driver.directory(instance, {
            instanceId: instance.id,
            path: "world/",
          })
          assert.isString(page.cursor)
          if (page.cursor) cursors.push(page.cursor)
        }

        const failure = yield* driver
          .directory(instance, {
            instanceId: instance.id,
            path: "world/",
          })
          .pipe(Effect.flip)
        assert.instanceOf(failure, RelayFilesystemError)
        assert.strictEqual(failure.operation, "directory.open")

        const firstCursor = cursors[0]
        assert.isString(firstCursor)
        const resumed = yield* driver.directory(instance, {
          cursor: firstCursor,
          instanceId: instance.id,
          path: "world/",
        })
        assert.isNull(resumed.cursor)

        yield* Effect.forEach(
          cursors.slice(1),
          (cursor) =>
            driver.directory(instance, {
              cursor,
              instanceId: instance.id,
              path: "world/",
            }),
          { concurrency: 16, discard: true }
        )
      })
    )
  )
})

describe("Relay legacy file tree", () => {
  it.effect("stops collecting paths at the compatibility limit", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        for (let offset = 0; offset < 5_001; offset += 256) {
          yield* fromPromise(() =>
            Promise.all(
              Array.from(
                { length: Math.min(256, 5_001 - offset) },
                (_, index) =>
                  writeFile(resolve(root, `entry-${offset + index}.txt`), "")
              )
            )
          )
        }

        const tree = yield* driver.tree(instance)

        assert.lengthOf(tree.paths, 5_000)
        assert.isTrue(tree.truncated)
      })
    )
  )

  it.effect("stops walking below the compatibility depth", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        let directory = resolve(root, "world")
        for (let depth = 0; depth < 12; depth += 1) {
          directory = resolve(directory, `level-${depth}`)
          yield* fromPromise(() => mkdir(directory))
        }

        const tree = yield* driver.tree(instance)

        assert.isTrue(tree.truncated)
        assert.include(tree.paths, "world/level-0/level-1/")
        assert.notInclude(
          tree.paths,
          "world/level-0/level-1/level-2/level-3/level-4/level-5/level-6/level-7/level-8/level-9/level-10/"
        )
      })
    )
  )
})

describe("Relay NBT file editing", () => {
  it.effect(
    "opens, validates, force saves, and repairs compressed player data",
    () =>
      withSetup(({ driver, instance, root }) =>
        Effect.gen(function* () {
          const path = resolve(root, "world", "player.dat")
          const original = gzipSync(
            encodeNbt({
              name: "",
              tag: parseSnbt("{Health: 20.0f, Inventory: []}", {
                binaryCompatible: true,
              }),
            })
          )
          yield* fromPromise(() => writeFile(path, original))

          const backupPath = resolve(root, "world", "level.dat_old")
          yield* fromPromise(() => writeFile(backupPath, original))
          const openedBackup = yield* driver.read(
            instance,
            "world/level.dat_old"
          )
          assert.strictEqual(openedBackup.encoding, "nbt-gzip")
          assert.include(openedBackup.content, "Health: 20.0f")

          const opened = yield* driver.read(instance, "world/player.dat")
          assert.strictEqual(opened.encoding, "nbt-gzip")
          assert.include(opened.content, "Health: 20.0f")
          assert.isFalse(opened.readOnly)

          const invalid = `${opened.content.slice(0, -2)},`
          const failure = yield* driver
            .write(instance, "world/player.dat", {
              content: invalid,
              expectedModifiedAt: opened.modifiedAt,
            })
            .pipe(Effect.flip)
          assert.instanceOf(failure, RelayFilesystemError)
          assert.strictEqual(failure.code, "invalid_snbt")
          assert.deepEqual(yield* fromPromise(() => readFile(path)), original)

          const forced = yield* driver.write(instance, "world/player.dat", {
            content: invalid,
            expectedModifiedAt: opened.modifiedAt,
            force: true,
          })
          assert.strictEqual(forced.encoding, "snbt-gzip")
          assert.strictEqual(
            gunzipSync(yield* fromPromise(() => readFile(path))).toString(
              "utf8"
            ),
            invalid
          )

          const repaired = yield* driver.write(instance, "world/player.dat", {
            content: "{Health: 18.0f, Inventory: []}\n",
            expectedModifiedAt: forced.modifiedAt,
          })
          assert.strictEqual(repaired.encoding, "nbt-gzip")
          const decoded = decodeNbt(
            gunzipSync(yield* fromPromise(() => readFile(path)))
          )
          assert.deepEqual(
            decoded.tag,
            parseSnbt("{Health: 18.0f, Inventory: []}", {
              binaryCompatible: true,
            })
          )
        })
      )
  )

  it.effect("preserves uncompressed NBT through force-save recovery", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const requestedPath = "world/servers.dat"
        const path = resolve(root, requestedPath)
        yield* fromPromise(() =>
          writeFile(
            path,
            encodeNbt({
              name: "",
              tag: parseSnbt('{servers: [{name: "Local"}]}', {
                binaryCompatible: true,
              }),
            })
          )
        )

        const opened = yield* driver.read(instance, requestedPath)
        assert.strictEqual(opened.encoding, "nbt")
        const invalid = opened.content.slice(0, -2)
        const forced = yield* driver.write(instance, requestedPath, {
          content: invalid,
          expectedModifiedAt: opened.modifiedAt,
          force: true,
        })
        assert.strictEqual(forced.encoding, "snbt")
        assert.strictEqual(
          yield* fromPromise(() => readFile(path, "utf8")),
          invalid
        )

        const repaired = yield* driver.write(instance, requestedPath, {
          content: '{servers: [{name: "Repaired"}]}\n',
          expectedModifiedAt: forced.modifiedAt,
        })
        assert.strictEqual(repaired.encoding, "nbt")
        assert.deepEqual(
          decodeNbt(yield* fromPromise(() => readFile(path))).tag,
          parseSnbt('{servers: [{name: "Repaired"}]}', {
            binaryCompatible: true,
          })
        )
      })
    )
  )
})

describeLinux("Relay direct file transfers", () => {
  it.effect(
    "renames, duplicates, archives, unarchives, and deletes entries",
    () =>
      withSetup(({ driver, instance, root }) =>
        Effect.gen(function* () {
          yield* fromPromise(() =>
            writeFile(resolve(root, "world", "data.txt"), "settings")
          )
          yield* driver.mutate(instance, {
            operation: "rename",
            path: "world/data.txt",
            destination: "world/server.txt",
          })
          yield* driver.mutate(instance, {
            operation: "duplicate",
            paths: ["world/server.txt"],
          })
          yield* driver.mutate(instance, {
            operation: "archive",
            paths: ["world/server.txt", "world/server copy.txt"],
            destination: "world/configs.zip",
          })
          const archived = yield* driver.tree(instance)
          assert.include(archived.paths, "world/configs.zip")
          assert.strictEqual(archived.sizes["world/server.txt"], 8)
          assert.isAtLeast(archived.sizes["world/"] ?? 0, 16)
          assert.strictEqual(archived.sizes[""], archived.sizes["world/"])
          assert.isAbove(archived.modifiedAt["world/server.txt"] ?? 0, 0)
          assert.isAbove(archived.modifiedAt["world/"] ?? 0, 0)
          const archive = yield* fromPromise(() =>
            readFile(resolve(root, "world", "configs.zip"))
          )
          assert.strictEqual(archive.subarray(0, 2).toString(), "PK")

          yield* driver.mutate(instance, {
            operation: "unarchive",
            path: "world/configs.zip",
            destination: "world/configs",
          })
          assert.strictEqual(
            yield* fromPromise(() =>
              readFile(resolve(root, "world", "configs", "server.txt"), "utf8")
            ),
            "settings"
          )
          assert.strictEqual(
            yield* fromPromise(() =>
              readFile(
                resolve(root, "world", "configs", "server copy.txt"),
                "utf8"
              )
            ),
            "settings"
          )
          for (const suffix of [" (1)", " (2)"]) {
            yield* driver.mutate(instance, {
              operation: "unarchive",
              path: "world/configs.zip",
              destination: "world/configs",
            })
            assert.strictEqual(
              yield* fromPromise(() =>
                readFile(
                  resolve(root, "world", `configs${suffix}`, "server.txt"),
                  "utf8"
                )
              ),
              "settings"
            )
          }

          yield* driver.mutate(instance, {
            operation: "delete",
            paths: ["world/server.txt", "world/server copy.txt"],
          })
          const deleted = yield* driver.tree(instance)
          assert.notInclude(deleted.paths, "world/server.txt")
          assert.notInclude(deleted.paths, "world/server copy.txt")
        })
      )
  )

  it.effect(
    "extracts one root file directly and preserves archived directories",
    () =>
      withSetup(({ driver, instance, root }) =>
        Effect.gen(function* () {
          yield* fromPromise(() =>
            writeFile(resolve(root, "world", "readme.txt"), "single file")
          )
          yield* driver.mutate(instance, {
            operation: "archive",
            paths: ["world/readme.txt"],
            destination: "world/bundle.zip",
          })
          for (const suffix of ["", " (1)", " (2)"]) {
            yield* driver.mutate(instance, {
              operation: "unarchive",
              path: "world/bundle.zip",
              destination: "world/bundle",
            })
            assert.strictEqual(
              yield* fromPromise(() =>
                readFile(resolve(root, "world", `bundle${suffix}.txt`), "utf8")
              ),
              "single file"
            )
          }

          yield* fromPromise(async () => {
            await mkdir(resolve(root, "world", "only"))
            await writeFile(
              resolve(root, "world", "only", "inside.txt"),
              "nested"
            )
          })
          yield* driver.mutate(instance, {
            operation: "archive",
            paths: ["world/only"],
            destination: "world/only.zip",
          })
          yield* driver.mutate(instance, {
            operation: "unarchive",
            path: "world/only.zip",
            destination: "world/only-extracted",
          })
          assert.strictEqual(
            yield* fromPromise(() =>
              readFile(
                resolve(root, "world", "only-extracted", "only", "inside.txt"),
                "utf8"
              )
            ),
            "nested"
          )
        })
      )
  )

  it.effect("atomically uploads and reads through a pinned file handle", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const uploaded = yield* driver.upload(
          instance,
          "world/data.txt",
          chunks("direct transfer")
        )
        assert.strictEqual(uploaded.size, 15)
        assert.lengthOf(uploaded.sha256, 64)

        const contents = yield* driver.withDownload(
          instance,
          "world/data.txt",
          (download) =>
            fromPromise(async () => {
              assert.strictEqual(download.size, 15)
              return download.file.readFile("utf8")
            })
        )
        assert.strictEqual(contents, "direct transfer")
        assert.isNotEmpty(root)
      })
    )
  )

  it.effect(
    "unarchives compressed TAR files with direct files and wrapped trees",
    () =>
      withSetup(({ driver, instance, root }) =>
        Effect.gen(function* () {
          yield* fromPromise(() =>
            writeTarGzArchive(resolve(root, "world", "bundle.tar.gz"), [
              { content: "single tar file", name: "readme.txt" },
            ])
          )
          for (const suffix of ["", " (1)"]) {
            yield* driver.mutate(instance, {
              operation: "unarchive",
              path: "world/bundle.tar.gz",
              destination: "world/bundle",
            })
            assert.strictEqual(
              yield* fromPromise(() =>
                readFile(resolve(root, "world", `bundle${suffix}.txt`), "utf8")
              ),
              "single tar file"
            )
          }

          yield* fromPromise(() =>
            writeTarGzArchive(resolve(root, "world", "tree.tgz"), [
              { name: "only/", type: "directory" },
              { content: "nested tar file", name: "only/inside.txt" },
            ])
          )
          yield* driver.mutate(instance, {
            operation: "unarchive",
            path: "world/tree.tgz",
            destination: "world/tree",
          })
          assert.strictEqual(
            yield* fromPromise(() =>
              readFile(
                resolve(root, "world", "tree", "only", "inside.txt"),
                "utf8"
              )
            ),
            "nested tar file"
          )
        })
      )
  )

  it.effect("returns a filesystem error for a malformed archive", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* fromPromise(() =>
          writeFile(resolve(root, "world", "broken.tar.gz"), "not an archive")
        )

        const failure = yield* driver
          .mutate(instance, {
            operation: "unarchive",
            path: "world/broken.tar.gz",
            destination: "world/broken",
          })
          .pipe(Effect.flip)

        assert.instanceOf(failure, RelayFilesystemError)
        assert.strictEqual(failure.code, "invalid_archive")
        assert.strictEqual(failure.operation, "mutation.unarchive")
      })
    )
  )

  it.effect("creates missing parents for concurrent nested uploads", () =>
    withSetup(({ driver, instance }) =>
      Effect.gen(function* () {
        yield* Effect.all(
          [
            driver.upload(
              instance,
              "packs/example/config/server.yml",
              chunks("server")
            ),
            driver.upload(
              instance,
              "packs/example/config/messages.yml",
              chunks("messages")
            ),
          ],
          { concurrency: "unbounded" }
        )

        const [server, messages] = yield* Effect.all([
          driver.withDownload(
            instance,
            "packs/example/config/server.yml",
            (download) => fromPromise(() => download.file.readFile("utf8"))
          ),
          driver.withDownload(
            instance,
            "packs/example/config/messages.yml",
            (download) => fromPromise(() => download.file.readFile("utf8"))
          ),
        ])
        assert.strictEqual(server, "server")
        assert.strictEqual(messages, "messages")
      })
    )
  )

  it.effect(
    "collects archive downloads without writing into the instance",
    () =>
      withSetup(({ driver, instance, root }) =>
        Effect.gen(function* () {
          yield* fromPromise(() =>
            Promise.all([
              mkdir(resolve(root, "world", "config")),
              writeFile(resolve(root, "world", "data.txt"), "data"),
            ])
          )
          yield* fromPromise(() =>
            writeFile(resolve(root, "world", "config", "server.yml"), "server")
          )
          const before = yield* fromPromise(() =>
            readdir(resolve(root, "world"))
          )

          const entries = yield* driver.withArchiveDownload(
            instance,
            ["world/config/", "world/data.txt"],
            (downloadEntries) =>
              Effect.succeed(
                downloadEntries.map((entry) => ({
                  kind: entry.kind,
                  name: entry.name,
                }))
              )
          )

          assert.deepInclude(entries, { kind: "directory", name: "config" })
          assert.deepInclude(entries, {
            kind: "file",
            name: "config/server.yml",
          })
          assert.deepInclude(entries, { kind: "file", name: "data.txt" })
          const after = yield* fromPromise(() =>
            readdir(resolve(root, "world"))
          )
          assert.deepEqual(after, before)
          assert.notInclude(after, "selected-files.zip")
        })
      )
  )

  it.effect("refuses a final symlink for transfers and file actions", () =>
    withSetup(({ directory, driver, instance, root }) =>
      Effect.gen(function* () {
        const outside = resolve(directory, "outside.txt")
        yield* fromPromise(() => writeFile(outside, "sensitive"))
        yield* fromPromise(() =>
          symlink(outside, resolve(root, "world", "escape.txt"))
        )

        const downloadFailure = yield* driver
          .withDownload(instance, "world/escape.txt", () => Effect.void)
          .pipe(Effect.flip)
        assert.instanceOf(downloadFailure, RelayFilesystemError)

        const uploadFailure = yield* driver
          .upload(instance, "world/escape.txt", chunks("overwrite"))
          .pipe(Effect.flip)
        assert.instanceOf(uploadFailure, RelayFilesystemError)
        assert.strictEqual(uploadFailure.code, "not_a_file")

        const mutationFailure = yield* driver
          .mutate(instance, {
            operation: "duplicate",
            paths: ["world/escape.txt"],
          })
          .pipe(Effect.flip)
        assert.instanceOf(mutationFailure, RelayFilesystemError)
        assert.strictEqual(mutationFailure.code, "unsupported_file")
      })
    )
  )

  it.effect("refuses symlinks in newly requested upload parents", () =>
    withSetup(({ directory, driver, instance, root }) =>
      Effect.gen(function* () {
        const outside = resolve(directory, "outside")
        yield* fromPromise(() => mkdir(outside))
        yield* fromPromise(() =>
          symlink(outside, resolve(root, "world", "linked"))
        )

        const failure = yield* driver
          .upload(instance, "world/linked/nested.txt", chunks("blocked"))
          .pipe(Effect.flip)
        assert.instanceOf(failure, RelayFilesystemError)
        assert.strictEqual(failure.code, "not_a_directory")
        const outsideEntries = yield* fromPromise(() => readdir(outside))
        assert.isEmpty(outsideEntries)
      })
    )
  )

  it.effect("closes downloads and removes failed upload temporaries", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        yield* driver.upload(instance, "world/data.txt", chunks("original"))

        let downloadHandle: FileHandle | undefined
        yield* driver
          .withDownload(instance, "world/data.txt", (download) =>
            Effect.sync(() => {
              downloadHandle = download.file
              throw new Error("consumer stopped")
            })
          )
          .pipe(Effect.exit)
        assert.strictEqual(downloadHandle?.fd, -1)

        const uploadFailure = yield* driver
          .upload(instance, "world/data.txt", failingChunks())
          .pipe(Effect.flip)
        assert.instanceOf(uploadFailure, RelayFilesystemError)
        assert.strictEqual(uploadFailure.operation, "upload.read")

        const entries = yield* fromPromise(() =>
          readdir(resolve(root, "world"))
        )
        assert.deepEqual(entries, ["data.txt"])
        const contents = yield* driver.withDownload(
          instance,
          "world/data.txt",
          (download) => fromPromise(() => download.file.readFile("utf8"))
        )
        assert.strictEqual(contents, "original")
      })
    )
  )

  it.effect("closes a pinned download descriptor when interrupted", () =>
    withSetup(({ driver, instance }) =>
      Effect.gen(function* () {
        yield* driver.upload(instance, "world/data.txt", chunks("interrupt"))
        const opened = yield* Deferred.make<FileHandle>()
        const fiber = yield* driver
          .withDownload(instance, "world/data.txt", (download) =>
            Deferred.succeed(opened, download.file).pipe(
              Effect.andThen(Effect.never)
            )
          )
          .pipe(Effect.forkChild)
        const handle = yield* Deferred.await(opened)

        yield* Fiber.interrupt(fiber)

        assert.strictEqual(handle.fd, -1)
      })
    )
  )

  it.effect("rejects downloads above the browser transfer limit", () =>
    withSetup(({ driver, instance, root }) =>
      Effect.gen(function* () {
        const oversized = resolve(root, "world", "oversized.bin")
        yield* fromPromise(async () => {
          await writeFile(oversized, "")
          await truncate(oversized, MAX_TRANSFER_BYTES + 1)
        })

        const failure = yield* driver
          .withDownload(instance, "world/oversized.bin", () => Effect.void)
          .pipe(Effect.flip)

        assert.instanceOf(failure, RelayFilesystemError)
        assert.strictEqual(failure.code, "file_too_large")
      })
    )
  )
})

function withSetup<TResult>(
  use: (setup: {
    directory: string
    driver: FilesystemDriver
    instance: RelayInstanceConfig
    root: string
  }) => Effect.Effect<TResult, unknown>
) {
  return Effect.acquireUseRelease(
    fromPromise(() => mkdtemp(resolve(tmpdir(), "kiln-files-test-"))),
    (directory) =>
      Effect.gen(function* () {
        const root = resolve(directory, "instances", "instance-1")
        yield* fromPromise(() =>
          mkdir(resolve(root, "world"), { recursive: true })
        )
        const config = loadConfig({
          KILN_RELAY_DATA_DIR: directory,
          KILN_RELAY_HOST: "relay.test",
          NODE_ENV: "development",
        })
        return yield* use({
          directory,
          driver: new FilesystemDriver(config),
          instance: testInstance(),
          root,
        })
      }),
    (directory) =>
      fromPromise(() => rm(directory, { force: true, recursive: true })).pipe(
        Effect.orDie
      )
  )
}

async function* chunks(value: string): AsyncIterable<Uint8Array> {
  yield Buffer.from(value)
}

async function* failingChunks(): AsyncIterable<Uint8Array> {
  yield Buffer.from("partial")
  throw new Error("upload stream failed")
}

async function writeTarGzArchive(
  path: string,
  entries: ReadonlyArray<{
    content?: string
    name: string
    type?: TarHeaders["type"]
  }>
): Promise<void> {
  const archive = createTarPack()
  const packed = consumeBuffer(archive)
  for (const entry of entries) {
    archive.entry(
      { name: entry.name, type: entry.type ?? "file" },
      Buffer.from(entry.content ?? "")
    )
  }
  archive.finalize()
  await writeFile(path, gzipSync(await packed))
}

function fromPromise<TResult>(run: () => Promise<TResult>) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) => cause,
  })
}

function testInstance(): RelayInstanceConfig {
  return {
    connectAddress: "localhost",
    directory: "instance-1",
    game: "Minecraft",
    id: "instance-1",
    implementation: "Paper",
    javaVersion: "21",
    limits: { diskBytes: 0, memoryBytes: 0 },
    managedByRelay: true,
    name: "Test Instance",
    ports: [],
    service: "test",
    shortId: "instance",
    tailscale: { enabled: false },
    version: "1.21.11",
  }
}
