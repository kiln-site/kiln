import {
  cp,
  lstat,
  mkdir,
  open,
  opendir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises"
import {
  constants as fsConstants,
  createReadStream,
  createWriteStream,
} from "node:fs"
import type { Dir, Dirent } from "node:fs"
import type { FileHandle } from "node:fs/promises"
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path"
import { createHash, randomUUID } from "node:crypto"
import { gzip, gunzip, constants as zlibConstants } from "node:zlib"
import { promisify } from "node:util"
import { Effect, Result, Stream } from "effect"
import ZipStream from "zip-stream"

import type {
  RelayDirectoryPage,
  RelayDirectoryPageInput,
  RelayDirectorySizes,
  RelayDirectorySizesInput,
  RelayFileContent,
  RelayFileEntry,
  RelayFileMutationInput,
  RelayFileMutationResult,
  RelayFileSearchPage,
  RelayFileSearchPageInput,
  RelayFileTree,
  RelayLatestLog,
  RelaySaveFileInput,
} from "@workspace/contracts"
import { formatSnbt, parseSnbt } from "@workspace/contracts"

import type { RelayConfig, RelayInstanceConfig } from "./config.js"
import { directoryApparentSizeEffect } from "./disk-usage.js"
import { RelayFilesystemError } from "./effect/errors.js"
import { decodeNbt, encodeNbt } from "./nbt.js"

const MAX_FILE_BYTES = 2 * 1024 * 1024
const MAX_LOG_SHARE_BYTES = 10 * 1024 * 1024
const MAX_TREE_ITEMS = 5_000
const MAX_TREE_DEPTH = 10
const MAX_ARCHIVE_ITEMS = 50_000
const FILE_SCAN_PAGE_BYTES = 192 * 1024
const FILE_DIRECTORY_PAGE_ITEMS = 128
const FILE_SEARCH_PAGE_ITEMS = 512
const FILE_SEARCH_PAGE_VISITS = 8_192
const FILE_SCAN_SESSION_TTL_MS = 2 * 60_000
const FILE_SCAN_MAX_SESSIONS = 256
const FILE_DIRECTORY_SIZE_CACHE_TTL_MS = 30_000
const FILE_DIRECTORY_SIZE_CACHE_MAX_ENTRIES = 4_096
const FILE_DIRECTORY_SIZE_MAX_SCANS = 4
const FILE_DIRECTORY_SIZE_MAX_PENDING = 512
export const MAX_TRANSFER_BYTES = 20 * 1024 * 1024 * 1024
const gunzipAsync = promisify(gunzip)
const gzipAsync = promisify(gzip)

export class FilesystemDriver {
  readonly #config: RelayConfig
  readonly #directoryScans = new Map<string, DirectoryScan>()
  readonly #directorySizeCache = new Map<string, DirectorySizeCacheEntry>()
  readonly #directorySizeEpochs = new Map<string, number>()
  readonly #directorySizeQueue: Array<DirectorySizeScan> = []
  readonly #directorySizeScans = new Set<string>()
  readonly #activeDirectorySizeScans = new Map<string, DirectorySizeScan>()
  readonly #directorySizeRescans = new Map<string, DirectorySizeScan>()
  readonly #searchScans = new Map<string, SearchScan>()
  #openingDirectoryScans = 0

  constructor(config: RelayConfig) {
    this.#config = config
  }

  tree(instance: RelayInstanceConfig) {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.#instanceRoot(instance)
      const modifiedAt: Record<string, number> = {}
      const paths: Array<string> = []
      const sizes: Record<string, number> = {}
      let truncated = false

      const visit = (
        directory: string,
        depth: number
      ): Effect.Effect<number, RelayFilesystemError> =>
        Effect.gen(function* () {
          if (paths.length >= MAX_TREE_ITEMS || depth > MAX_TREE_DEPTH) {
            truncated = true
            return 0
          }

          const entries = yield* filesystemOperation(
            "tree.readDirectory",
            async () => {
              const values: Array<Dirent> = []
              for await (const entry of await opendir(directory)) {
                if (!supportedDirectoryEntry(entry)) continue
                if (values.length >= MAX_TREE_ITEMS - paths.length) {
                  truncated = true
                  break
                }
                values.push(entry)
              }
              return values
            }
          )
          entries.sort((left, right) => {
            if (left.isDirectory() !== right.isDirectory()) {
              return left.isDirectory() ? -1 : 1
            }
            return left.name.localeCompare(right.name)
          })

          const metadata = yield* Effect.forEach(
            entries,
            (entry) =>
              filesystemOperation("tree.stat", () =>
                lstat(join(directory, entry.name))
              ),
            { concurrency: 16 }
          )

          let directorySize = 0
          for (const [index, entry] of entries.entries()) {
            if (paths.length >= MAX_TREE_ITEMS) {
              truncated = true
              break
            }
            const absolute = join(directory, entry.name)
            const path = relative(root, absolute).split(sep).join("/")
            if (entry.isDirectory()) {
              const directoryPath = `${path}/`
              paths.push(directoryPath)
              modifiedAt[directoryPath] = metadata[index]?.mtimeMs ?? 0
              const size = yield* visit(absolute, depth + 1)
              sizes[directoryPath] = size
              directorySize += size
            } else if (entry.isFile() || entry.isSymbolicLink()) {
              paths.push(path)
              modifiedAt[path] = metadata[index]?.mtimeMs ?? 0
              const size = metadata[index]?.size ?? 0
              sizes[path] = size
              directorySize += size
            }
          }
          return directorySize
        })

      sizes[""] = yield* visit(root, 0)
      return {
        instanceId: instance.id,
        modifiedAt,
        paths,
        sizes,
        total: paths.length,
        truncated,
      } satisfies RelayFileTree
    }).pipe(Effect.withSpan("relay.files.tree"))
  }

  directory(instance: RelayInstanceConfig, input: RelayDirectoryPageInput) {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.#instanceRoot(instance)
      const requestedDirectory = normalizeDirectoryPath(input.path)
      let scan: DirectoryScan

      if (input.cursor) {
        const existing = this.#directoryScans.get(input.cursor)
        if (
          !existing ||
          existing.instanceId !== instance.id ||
          existing.directory !== requestedDirectory
        ) {
          return yield* filesystemFailure(
            "invalid_path",
            "directory.cursor",
            "Directory scan expired; refresh the directory to continue"
          )
        }
        scan = existing
      } else {
        if (!this.#reserveDirectoryScan()) {
          return yield* filesystemFailure(
            "io_error",
            "directory.open",
            "Too many active directory scans; retry shortly"
          )
        }
        scan = yield* Effect.gen({ self: this }, function* () {
          const absolute = yield* resolveInstanceDirectory(
            root,
            requestedDirectory
          )
          const handle = yield* filesystemOperation("directory.open", () =>
            opendir(absolute)
          )
          const opened: DirectoryScan = {
            busy: false,
            directory: requestedDirectory,
            expires: null,
            handle,
            id: randomUUID(),
            instanceId: instance.id,
            pending: null,
            root,
          }
          this.#directoryScans.set(opened.id, opened)
          this.#armDirectoryScan(opened)
          return opened
        }).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              this.#openingDirectoryScans -= 1
            })
          )
        )
      }

      if (scan.busy) {
        return yield* filesystemFailure(
          "io_error",
          "directory.cursor",
          "Directory scan is already being read"
        )
      }
      scan.busy = true
      this.#armDirectoryScan(scan)

      return yield* filesystemOperation("directory.read", () =>
        readDirectoryScanPage(scan)
      ).pipe(
        Effect.tap((page) =>
          Effect.sync(() => {
            if (!page.cursor) this.#finishDirectoryScan(scan)
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            scan.busy = false
          })
        )
      )
    }).pipe(Effect.withSpan("relay.files.directory"))
  }

  directorySizes(
    instance: RelayInstanceConfig,
    input: RelayDirectorySizesInput
  ) {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.#instanceRoot(instance)
      const paths = [...new Set(input.paths.map(normalizeDirectoryPath))]
      if (paths.some((path) => !path)) {
        return yield* filesystemFailure(
          "invalid_path",
          "directorySizes.path",
          "Select a directory below the instance root"
        )
      }
      yield* Effect.forEach(
        paths,
        (path) => validateRelativePath(path.replace(/\/$/u, "")),
        { concurrency: 16, discard: true }
      )
      const resolvedDirectories = yield* Effect.forEach(
        paths,
        (path) =>
          resolveInstanceDirectory(root, path).pipe(
            Effect.map((absolute) => ({ absolute, path })),
            Effect.catch(() => Effect.succeed(null))
          ),
        { concurrency: 16 }
      )
      const directories = resolvedDirectories.filter(
        (directory) => directory !== null
      )
      const now = Date.now()
      const pending: Array<string> = []
      const sizes: Record<string, number> = {}

      for (const directory of directories) {
        const key = directorySizeCacheKey(instance.id, directory.path)
        const cached = this.#directorySizeCache.get(key)
        if (cached && cached.size !== null) {
          sizes[directory.path] = cached.size
        }
        if (!cached || cached.expiresAt <= now) {
          const queued = this.#queueDirectorySizeScan({
            ...directory,
            epoch: this.#directorySizeEpoch(instance.id),
            instanceId: instance.id,
            key,
          })
          if (queued) pending.push(directory.path)
        }
      }

      return {
        instanceId: instance.id,
        pending,
        sizes,
      } satisfies RelayDirectorySizes
    }).pipe(Effect.withSpan("relay.files.directorySizes"))
  }

  search(instance: RelayInstanceConfig, input: RelayFileSearchPageInput) {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.#instanceRoot(instance)
      const query = input.query.trim()
      let scan: SearchScan

      if (input.cursor) {
        const existing = this.#searchScans.get(input.cursor)
        if (
          !existing ||
          existing.instanceId !== instance.id ||
          existing.query !== query
        ) {
          return yield* filesystemFailure(
            "invalid_path",
            "search.cursor",
            "File search expired; run the search again"
          )
        }
        scan = existing
      } else {
        if (this.#searchScans.size >= FILE_SCAN_MAX_SESSIONS) {
          return yield* filesystemFailure(
            "io_error",
            "search.open",
            "Too many active file searches; retry shortly"
          )
        }
        scan = {
          active: null,
          busy: false,
          expires: null,
          id: randomUUID(),
          instanceId: instance.id,
          pending: null,
          query,
          queryLower: query.toLowerCase(),
          queue: [{ absolute: root, directory: "" }],
          root,
        }
        this.#searchScans.set(scan.id, scan)
      }

      if (scan.busy) {
        return yield* filesystemFailure(
          "io_error",
          "search.cursor",
          "File search is already being read"
        )
      }
      scan.busy = true
      this.#armSearchScan(scan)

      return yield* filesystemOperation("search.read", () =>
        readSearchScanPage(scan)
      ).pipe(
        Effect.tap((page) =>
          Effect.sync(() => {
            if (!page.cursor) this.#finishSearchScan(scan)
          })
        ),
        Effect.ensuring(
          Effect.sync(() => {
            scan.busy = false
          })
        )
      )
    }).pipe(Effect.withSpan("relay.files.search"))
  }

  entry(instance: RelayInstanceConfig, requestedPath: string) {
    return Effect.gen({ self: this }, function* () {
      yield* validateRelativePath(requestedPath.replace(/\/$/u, ""))
      const root = yield* this.#instanceRoot(instance)
      const absolute = yield* filesystemOperation("stat.resolve", () =>
        realpath(resolve(root, requestedPath))
      )
      yield* ensureContained(root, absolute)
      const metadata = yield* filesystemOperation("stat.read", () =>
        lstat(absolute)
      )
      if (!metadata.isDirectory() && !metadata.isFile()) {
        return yield* filesystemFailure(
          "unsupported_file",
          "stat",
          "Path is not a regular file or directory"
        )
      }
      const kind = metadata.isDirectory() ? "directory" : "file"
      return {
        kind,
        modifiedAt: metadata.mtimeMs,
        path:
          kind === "directory"
            ? normalizeDirectoryPath(requestedPath)
            : requestedPath,
        size: kind === "directory" ? null : metadata.size,
      } satisfies RelayFileEntry
    }).pipe(Effect.withSpan("relay.files.stat"))
  }

  read(instance: RelayInstanceConfig, requestedPath: string) {
    return Effect.gen({ self: this }, function* () {
      const path = yield* this.#existingFile(instance, requestedPath)
      const metadata = yield* filesystemOperation("read.stat", () => stat(path))
      if (metadata.size > MAX_FILE_BYTES) {
        return yield* filesystemFailure(
          "file_too_large",
          "read",
          `Files larger than ${MAX_FILE_BYTES} bytes cannot be edited`
        )
      }
      const lowerPath = requestedPath.toLowerCase()
      const compressed = lowerPath.endsWith(".log.gz")
      if (lowerPath.endsWith(".gz") && !compressed) {
        return yield* filesystemFailure(
          "unsupported_file",
          "read",
          "Only Minecraft .log.gz archives can be previewed"
        )
      }

      const source = yield* filesystemOperation("read.contents", () =>
        readFile(path)
      )

      if (isBinaryNbtPath(lowerPath)) {
        const nbtSource = isGzip(source)
          ? yield* Effect.tryPromise({
              try: () =>
                gunzipAsync(source, { maxOutputLength: MAX_FILE_BYTES }),
              catch: (cause) =>
                makeFilesystemError(
                  "invalid_nbt",
                  "read.nbt.decompress",
                  `The NBT file is invalid or expands beyond ${MAX_FILE_BYTES} bytes`,
                  cause
                ),
            })
          : source
        const parsed = tryDecodeNbt(nbtSource)
        if (parsed) {
          return {
            instanceId: instance.id,
            path: requestedPath,
            content: formatSnbt(parsed.tag),
            size: metadata.size,
            decodedSize: nbtSource.byteLength,
            encoding: isGzip(source) ? "nbt-gzip" : "nbt",
            readOnly: false,
            modifiedAt: metadata.mtime.toISOString(),
          } satisfies RelayFileContent
        }

        const rawText = decodeUtf8(nbtSource)
        if (rawText !== null && looksLikeSnbt(rawText)) {
          return {
            instanceId: instance.id,
            path: requestedPath,
            content: rawText,
            size: metadata.size,
            decodedSize: nbtSource.byteLength,
            encoding: isGzip(source) ? "snbt-gzip" : "snbt",
            readOnly: false,
            modifiedAt: metadata.mtime.toISOString(),
          } satisfies RelayFileContent
        }
      }

      const decoded = compressed
        ? yield* Effect.tryPromise({
            try: () => gunzipAsync(source, { maxOutputLength: MAX_FILE_BYTES }),
            catch: (cause) =>
              makeFilesystemError(
                "invalid_gzip",
                "read.decompress",
                `The archived log is invalid or expands beyond ${MAX_FILE_BYTES} bytes`,
                cause
              ),
          })
        : source
      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(decoded),
        catch: (cause) =>
          makeFilesystemError(
            "unsupported_file",
            "read.decode",
            "This file is binary and cannot be previewed as text",
            cause
          ),
      })

      return {
        instanceId: instance.id,
        path: requestedPath,
        content,
        size: metadata.size,
        decodedSize: decoded.byteLength,
        encoding: lowerPath.endsWith(".snbt")
          ? "snbt"
          : compressed
            ? "gzip"
            : "utf8",
        readOnly: compressed,
        modifiedAt: metadata.mtime.toISOString(),
      } satisfies RelayFileContent
    }).pipe(Effect.withSpan("relay.files.read"))
  }

  write(
    instance: RelayInstanceConfig,
    requestedPath: string,
    input: RelaySaveFileInput
  ) {
    return Effect.gen({ self: this }, function* () {
      if (requestedPath.toLowerCase().endsWith(".log.gz")) {
        return yield* filesystemFailure(
          "read_only",
          "write",
          "Archived logs are read-only"
        )
      }
      const path = yield* this.#existingFile(instance, requestedPath)
      const metadata = yield* filesystemOperation("write.stat", () =>
        stat(path)
      )
      if (
        input.expectedModifiedAt &&
        metadata.mtime.toISOString() !== input.expectedModifiedAt
      ) {
        return yield* filesystemFailure(
          "file_changed",
          "write",
          "The file changed on disk after it was opened"
        )
      }

      const lowerPath = requestedPath.toLowerCase()
      const current = yield* filesystemOperation("write.read", () =>
        readFile(path)
      )
      const encoded = yield* prepareFileWrite(
        lowerPath,
        current,
        input.content,
        input.force ?? false
      )

      const temporary = `${path}.hearth-${process.pid}-${randomUUID()}`
      return yield* Effect.acquireUseRelease(
        filesystemOperation("write.temporary", () =>
          writeFile(temporary, encoded, { mode: metadata.mode })
        ),
        () =>
          filesystemOperation("write.replace", () =>
            rename(temporary, path)
          ).pipe(
            Effect.uninterruptible,
            Effect.flatMap(() => this.read(instance, requestedPath))
          ),
        () => cleanupPathEffect(temporary)
      )
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => this.#invalidateDirectorySizes(instance.id))
      ),
      Effect.withSpan("relay.files.write")
    )
  }

  latestLog(instance: RelayInstanceConfig) {
    return Effect.gen({ self: this }, function* () {
      const requestedPath = "logs/latest.log" as const
      const path = yield* this.#existingFile(instance, requestedPath)
      const metadata = yield* filesystemOperation("latestLog.stat", () =>
        stat(path)
      )
      if (metadata.size > MAX_LOG_SHARE_BYTES) {
        return yield* filesystemFailure(
          "log_too_large",
          "latestLog",
          `latest.log exceeds the ${MAX_LOG_SHARE_BYTES} byte sharing limit`
        )
      }
      const source = yield* filesystemOperation("latestLog.read", () =>
        readFile(path)
      )
      const content = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(source),
        catch: (cause) =>
          makeFilesystemError(
            "unsupported_file",
            "latestLog.decode",
            "latest.log is not valid UTF-8 text",
            cause
          ),
      })

      return {
        instanceId: instance.id,
        path: requestedPath,
        content,
        size: source.byteLength,
      } satisfies RelayLatestLog
    }).pipe(Effect.withSpan("relay.files.latestLog"))
  }

  withDownload<TResult, TError, TRequirements>(
    instance: RelayInstanceConfig,
    requestedPath: string,
    use: (download: {
      file: FileHandle
      modifiedAt: string
      name: string
      size: number
    }) => Effect.Effect<TResult, TError, TRequirements>
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* requireLinuxDescriptorAnchoring()
      yield* validateRelativePath(requestedPath)
      const root = yield* this.#instanceRoot(instance)
      const candidate = resolve(root, requestedPath)
      yield* ensureContained(root, candidate)

      return yield* Effect.acquireUseRelease(
        filesystemOperation("download.open", () =>
          open(candidate, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW)
        ),
        (file) =>
          Effect.gen(function* () {
            const actual = yield* filesystemOperation(
              "download.resolveDescriptor",
              () => realpath(fileDescriptorPath(file))
            )
            yield* ensureContained(root, actual)
            const metadata = yield* filesystemOperation(
              "download.statDescriptor",
              () => file.stat()
            )
            if (!metadata.isFile()) {
              return yield* filesystemFailure(
                "not_a_file",
                "download",
                "Path is not a file"
              )
            }
            if (metadata.size > MAX_TRANSFER_BYTES) {
              return yield* filesystemFailure(
                "file_too_large",
                "download",
                "Download exceeds the 20 GiB transfer limit"
              )
            }
            return yield* use({
              file,
              modifiedAt: metadata.mtime.toISOString(),
              name: basename(candidate),
              size: metadata.size,
            })
          }),
        (file) => closeHandleEffect(file, "download.close")
      )
    }).pipe(Effect.withSpan("relay.files.download"))
  }

  withArchiveDownload<TResult, TError, TRequirements>(
    instance: RelayInstanceConfig,
    requestedPaths: ReadonlyArray<string>,
    use: (
      entries: ReadonlyArray<ArchiveDownloadEntry>
    ) => Effect.Effect<TResult, TError, TRequirements>
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* requireLinuxDescriptorAnchoring()
      const root = yield* this.#instanceRoot(instance)
      const paths = distinctMutationPaths(requestedPaths)
      if (!paths.length) {
        return yield* filesystemFailure(
          "invalid_path",
          "download.archive",
          "Select files to download"
        )
      }
      const entries = yield* collectArchiveEntries(root, paths)
      return yield* use(entries)
    }).pipe(Effect.withSpan("relay.files.downloadArchive"))
  }

  upload(
    instance: RelayInstanceConfig,
    requestedPath: string,
    source: AsyncIterable<Uint8Array>
  ) {
    return Effect.gen({ self: this }, function* () {
      yield* requireLinuxDescriptorAnchoring()
      yield* validateRelativePath(requestedPath)
      const root = yield* this.#instanceRoot(instance)
      const segments = requestedPath
        .split("/")
        .filter((segment) => segment && segment !== ".")
      const name = segments.at(-1)
      if (!name) {
        return yield* filesystemFailure(
          "invalid_path",
          "upload",
          "Invalid relative path"
        )
      }
      return yield* Effect.scoped(
        openUploadParent(root, segments.slice(0, -1)).pipe(
          Effect.flatMap((parentHandle) =>
            uploadIntoParent(root, parentHandle, name, requestedPath, source)
          )
        )
      )
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => this.#invalidateDirectorySizes(instance.id))
      ),
      Effect.withSpan("relay.files.upload")
    )
  }

  mutate(instance: RelayInstanceConfig, input: RelayFileMutationInput) {
    return Effect.gen({ self: this }, function* () {
      const root = yield* this.#instanceRoot(instance)

      if (input.operation === "rename") {
        const source = yield* existingMutationEntry(root, input.path)
        const destination = yield* mutationDestination(root, input.destination)
        yield* requireMissingDestination(destination)
        yield* filesystemOperation("mutation.rename", () =>
          rename(source.absolute, destination)
        )
      }

      if (input.operation === "delete") {
        const paths = distinctMutationPaths(input.paths)
        yield* Effect.forEach(
          paths,
          (path) =>
            existingMutationEntry(root, path).pipe(
              Effect.flatMap((entry) =>
                filesystemOperation("mutation.delete", () =>
                  rm(entry.absolute, { recursive: true })
                )
              )
            ),
          { concurrency: 4, discard: true }
        )
      }

      if (input.operation === "duplicate") {
        const paths = distinctMutationPaths(input.paths)
        yield* Effect.forEach(
          paths,
          (path) =>
            Effect.gen(function* () {
              const source = yield* existingMutationEntry(root, path)
              const destination = yield* availableDuplicatePath(root, path)
              yield* filesystemOperation("mutation.duplicate", () =>
                cp(source.absolute, destination, {
                  errorOnExist: true,
                  force: false,
                  recursive: source.kind === "directory",
                })
              )
            }),
          { concurrency: 2, discard: true }
        )
      }

      if (input.operation === "archive") {
        const destination = yield* mutationDestination(root, input.destination)
        yield* requireMissingDestination(destination)
        const entries = yield* collectArchiveEntries(
          root,
          distinctMutationPaths(input.paths)
        )
        let completed = false
        yield* filesystemOperation("mutation.archive", (signal) =>
          writeZipArchive(destination, entries, signal)
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              completed = true
            })
          ),
          Effect.ensuring(
            Effect.suspend(() =>
              completed ? Effect.void : cleanupPathEffect(destination)
            )
          )
        )
      }

      return { mutated: true } satisfies RelayFileMutationResult
    }).pipe(
      Effect.tap(() =>
        Effect.sync(() => this.#invalidateDirectorySizes(instance.id))
      ),
      Effect.withSpan("relay.files.mutate")
    )
  }

  #directorySizeEpoch(instanceId: string) {
    return this.#directorySizeEpochs.get(instanceId) ?? 0
  }

  #invalidateDirectorySizes(instanceId: string) {
    const epoch = this.#directorySizeEpoch(instanceId) + 1
    this.#directorySizeEpochs.set(instanceId, epoch)
    const prefix = `${instanceId}\0`
    for (const key of this.#directorySizeCache.keys()) {
      if (key.startsWith(prefix)) this.#directorySizeCache.delete(key)
    }
    for (let index = this.#directorySizeQueue.length - 1; index >= 0; index--) {
      const scan = this.#directorySizeQueue[index]
      if (!scan || scan.instanceId !== instanceId) continue
      this.#directorySizeQueue.splice(index, 1)
      this.#directorySizeScans.delete(scan.key)
    }
    for (const scan of this.#activeDirectorySizeScans.values()) {
      if (scan.instanceId !== instanceId) continue
      this.#directorySizeRescans.set(scan.key, { ...scan, epoch })
    }
  }

  #queueDirectorySizeScan(scan: DirectorySizeScan) {
    if (this.#directorySizeScans.has(scan.key)) {
      const active = this.#activeDirectorySizeScans.get(scan.key)
      if (active && active.epoch !== scan.epoch) {
        this.#directorySizeRescans.set(scan.key, scan)
      }
      return true
    }
    if (this.#directorySizeScans.size >= FILE_DIRECTORY_SIZE_MAX_PENDING) {
      return false
    }
    this.#directorySizeScans.add(scan.key)
    this.#directorySizeQueue.push(scan)
    this.#drainDirectorySizeQueue()
    return true
  }

  #drainDirectorySizeQueue() {
    while (
      this.#activeDirectorySizeScans.size < FILE_DIRECTORY_SIZE_MAX_SCANS &&
      this.#directorySizeQueue.length
    ) {
      const scan = this.#directorySizeQueue.shift()
      if (!scan) return
      this.#activeDirectorySizeScans.set(scan.key, scan)
      Effect.runFork(
        directoryApparentSizeEffect(scan.absolute).pipe(
          Effect.tap((size) =>
            Effect.sync(() => this.#cacheDirectorySize(scan, size))
          ),
          Effect.catch(() =>
            Effect.sync(() => this.#cacheDirectorySize(scan, null))
          ),
          Effect.ensuring(
            Effect.sync(() => {
              const rescan = this.#directorySizeRescans.get(scan.key)
              this.#directorySizeRescans.delete(scan.key)
              this.#activeDirectorySizeScans.delete(scan.key)
              this.#directorySizeScans.delete(scan.key)
              if (rescan) this.#queueDirectorySizeScan(rescan)
              this.#drainDirectorySizeQueue()
            })
          )
        )
      )
    }
  }

  #cacheDirectorySize(scan: DirectorySizeScan, size: number | null) {
    if (scan.epoch !== this.#directorySizeEpoch(scan.instanceId)) return
    this.#directorySizeCache.delete(scan.key)
    this.#directorySizeCache.set(scan.key, {
      expiresAt: Date.now() + FILE_DIRECTORY_SIZE_CACHE_TTL_MS,
      size,
    })
    while (
      this.#directorySizeCache.size > FILE_DIRECTORY_SIZE_CACHE_MAX_ENTRIES
    ) {
      const oldest = this.#directorySizeCache.keys().next().value
      if (oldest === undefined) break
      this.#directorySizeCache.delete(oldest)
    }
  }

  #existingFile(instance: RelayInstanceConfig, requestedPath: string) {
    return Effect.gen({ self: this }, function* () {
      yield* validateRelativePath(requestedPath)
      const root = yield* this.#instanceRoot(instance)
      const candidate = yield* filesystemOperation("path.resolveFile", () =>
        realpath(resolve(root, requestedPath))
      )
      yield* ensureContained(root, candidate)
      const metadata = yield* filesystemOperation("path.statFile", () =>
        lstat(candidate)
      )
      if (!metadata.isFile()) {
        return yield* filesystemFailure(
          "not_a_file",
          "path",
          "Path is not a file"
        )
      }
      return candidate
    })
  }

  #instanceRoot(instance: RelayInstanceConfig) {
    const config = this.#config
    return Effect.gen(function* () {
      const configuredRoot = yield* filesystemOperation(
        "path.resolveConfiguredRoot",
        () => realpath(config.rootDirectory)
      )
      const root = yield* filesystemOperation("path.resolveInstanceRoot", () =>
        realpath(resolve(configuredRoot, instance.directory))
      )
      yield* ensureContained(configuredRoot, root)
      return root
    })
  }

  #armDirectoryScan(scan: DirectoryScan) {
    if (scan.expires) clearTimeout(scan.expires)
    scan.expires = setTimeout(() => {
      this.#finishDirectoryScan(scan)
    }, FILE_SCAN_SESSION_TTL_MS)
    scan.expires.unref()
  }

  #finishDirectoryScan(scan: DirectoryScan) {
    if (scan.expires) clearTimeout(scan.expires)
    scan.expires = null
    this.#directoryScans.delete(scan.id)
    Effect.runFork(closeDirectoryEffect(scan.handle).pipe(Effect.ignore))
  }

  #reserveDirectoryScan() {
    if (
      this.#directoryScans.size + this.#openingDirectoryScans >=
      FILE_SCAN_MAX_SESSIONS
    ) {
      return false
    }
    this.#openingDirectoryScans += 1
    return true
  }

  #armSearchScan(scan: SearchScan) {
    if (scan.expires) clearTimeout(scan.expires)
    scan.expires = setTimeout(() => {
      this.#finishSearchScan(scan)
    }, FILE_SCAN_SESSION_TTL_MS)
    scan.expires.unref()
  }

  #finishSearchScan(scan: SearchScan) {
    if (scan.expires) clearTimeout(scan.expires)
    scan.expires = null
    this.#searchScans.delete(scan.id)
    if (scan.active) {
      Effect.runFork(
        closeDirectoryEffect(scan.active.handle).pipe(Effect.ignore)
      )
    }
    scan.active = null
  }
}

interface DirectoryScan {
  busy: boolean
  directory: string
  expires: ReturnType<typeof setTimeout> | null
  handle: Dir
  id: string
  instanceId: string
  pending: Dirent | null
  root: string
}

interface SearchDirectory {
  absolute: string
  directory: string
}

interface SearchScan {
  active: (SearchDirectory & { handle: Dir }) | null
  busy: boolean
  expires: ReturnType<typeof setTimeout> | null
  id: string
  instanceId: string
  pending: Dirent | null
  query: string
  queryLower: string
  queue: Array<SearchDirectory>
  root: string
}

interface DirectorySizeCacheEntry {
  expiresAt: number
  size: number | null
}

interface DirectorySizeScan {
  absolute: string
  epoch: number
  instanceId: string
  key: string
  path: string
}

function directorySizeCacheKey(instanceId: string, path: string) {
  return `${instanceId}\0${path}`
}

function normalizeDirectoryPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/gu, "")
  return normalized ? `${normalized}/` : ""
}

function fileEntryPath(directory: string, entry: Dirent): string {
  const path = `${directory}${entry.name}`
  return entry.isDirectory() ? `${path}/` : path
}

function supportedDirectoryEntry(entry: Dirent): boolean {
  return entry.isDirectory() || entry.isFile() || entry.isSymbolicLink()
}

async function relayFileEntry(
  root: string,
  directory: string,
  entry: Dirent
): Promise<RelayFileEntry> {
  const path = fileEntryPath(directory, entry)
  const metadata = await lstat(join(root, path.replace(/\/$/u, "")))
  const kind = entry.isDirectory() ? "directory" : "file"
  return {
    kind,
    modifiedAt: metadata.mtimeMs,
    path,
    size: kind === "directory" ? null : metadata.size,
  }
}

function estimatedFileEntryBytes(path: string): number {
  return Buffer.byteLength(path) + 96
}

async function readDirectoryScanPage(
  scan: DirectoryScan
): Promise<RelayDirectoryPage> {
  const entries: Array<Dirent> = []
  let estimatedBytes = 0
  let complete = false

  while (entries.length < FILE_DIRECTORY_PAGE_ITEMS) {
    const entry = scan.pending ?? (await scan.handle.read())
    scan.pending = null
    if (!entry) {
      complete = true
      break
    }
    if (!supportedDirectoryEntry(entry)) continue
    const nextBytes = estimatedFileEntryBytes(
      fileEntryPath(scan.directory, entry)
    )
    if (
      entries.length > 0 &&
      estimatedBytes + nextBytes > FILE_SCAN_PAGE_BYTES
    ) {
      scan.pending = entry
      break
    }
    entries.push(entry)
    estimatedBytes += nextBytes
  }

  const resolved: Array<RelayFileEntry> = []
  for (let offset = 0; offset < entries.length; offset += 16) {
    resolved.push(
      ...(await Promise.all(
        entries
          .slice(offset, offset + 16)
          .map((entry) => relayFileEntry(scan.root, scan.directory, entry))
      ))
    )
  }
  return {
    cursor: complete ? null : scan.id,
    directory: scan.directory,
    entries: resolved,
    instanceId: scan.instanceId,
  }
}

async function readSearchScanPage(
  scan: SearchScan
): Promise<RelayFileSearchPage> {
  const entries: Array<RelayFileEntry> = []
  let estimatedBytes = 0
  let visits = 0

  while (
    entries.length < FILE_SEARCH_PAGE_ITEMS &&
    visits < FILE_SEARCH_PAGE_VISITS
  ) {
    if (!scan.active) {
      const next = scan.queue.shift()
      if (!next) break
      scan.active = { ...next, handle: await opendir(next.absolute) }
    }

    const entry = scan.pending ?? (await scan.active.handle.read())
    scan.pending = null
    if (!entry) {
      await Effect.runPromise(closeDirectoryEffect(scan.active.handle))
      scan.active = null
      continue
    }
    if (!supportedDirectoryEntry(entry)) continue
    visits += 1

    const path = fileEntryPath(scan.active.directory, entry)
    const matches = path.toLowerCase().includes(scan.queryLower)

    const nextBytes = estimatedFileEntryBytes(path)
    if (
      matches &&
      entries.length > 0 &&
      estimatedBytes + nextBytes > FILE_SCAN_PAGE_BYTES
    ) {
      scan.pending = entry
      break
    }
    if (entry.isDirectory()) {
      scan.queue.push({
        absolute: join(scan.root, path.replace(/\/$/u, "")),
        directory: path,
      })
    }
    if (matches) {
      entries.push(
        await relayFileEntry(scan.root, scan.active.directory, entry)
      )
      estimatedBytes += nextBytes
    }
  }

  const complete = !scan.active && scan.queue.length === 0
  return {
    cursor: complete ? null : scan.id,
    entries,
    instanceId: scan.instanceId,
    query: scan.query,
  }
}

function closeDirectoryEffect(handle: Dir) {
  return Effect.tryPromise({
    try: () => handle.close(),
    catch: (cause) => cause,
  }).pipe(
    Effect.catchIf(
      (cause) =>
        Boolean(
          cause &&
          typeof cause === "object" &&
          "code" in cause &&
          cause.code === "ERR_DIR_CLOSED"
        ),
      () => Effect.void
    )
  )
}

function resolveInstanceDirectory(root: string, directory: string) {
  return Effect.gen(function* () {
    const requested = directory.replace(/\/$/u, "")
    if (requested) yield* validateRelativePath(requested)
    const candidate = requested
      ? yield* filesystemOperation("directory.resolve", () =>
          realpath(resolve(root, requested))
        )
      : root
    yield* ensureContained(root, candidate)
    const metadata = yield* filesystemOperation("directory.stat", () =>
      lstat(candidate)
    )
    if (!metadata.isDirectory()) {
      return yield* filesystemFailure(
        "not_a_directory",
        "directory",
        "Path is not a directory"
      )
    }
    return candidate
  })
}

function fileDescriptorPath(file: FileHandle): string {
  return `/proc/self/fd/${file.fd}`
}

const openUploadParent = Effect.fn("relay.files.openUploadParent")(function* (
  root: string,
  segments: ReadonlyArray<string>
) {
  let parentHandle = yield* Effect.acquireRelease(
    filesystemOperation("upload.openRoot", () =>
      open(
        root,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
      )
    ),
    (handle) => closeHandleEffect(handle, "upload.closeRoot")
  )

  for (const segment of segments) {
    const child = resolve(fileDescriptorPath(parentHandle), segment)
    const existing = yield* optionalFileMetadata(child)
    if (!existing) {
      yield* filesystemOperation("upload.createParent", () =>
        mkdir(child, { mode: 0o755 })
      ).pipe(
        Effect.catchIf(
          (cause) => isAlreadyExists(cause.cause),
          () => Effect.void
        )
      )
    }
    const metadata = yield* filesystemOperation("upload.statParent", () =>
      lstat(child)
    )
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      return yield* filesystemFailure(
        "not_a_directory",
        "upload",
        "An upload parent path is not a directory"
      )
    }
    const childHandle = yield* Effect.acquireRelease(
      filesystemOperation("upload.openParent", () =>
        open(
          child,
          fsConstants.O_RDONLY |
            fsConstants.O_DIRECTORY |
            fsConstants.O_NOFOLLOW
        )
      ),
      (handle) => closeHandleEffect(handle, "upload.closeParent")
    )
    const resolvedChild = yield* filesystemOperation(
      "upload.resolveParentDescriptor",
      () => realpath(fileDescriptorPath(childHandle))
    )
    yield* ensureContained(root, resolvedChild)
    parentHandle = childHandle
  }

  return parentHandle
})

const uploadIntoParent = Effect.fn("relay.files.uploadIntoParent")(function* (
  root: string,
  parentHandle: FileHandle,
  name: string,
  requestedPath: string,
  source: AsyncIterable<Uint8Array>
) {
  const anchoredParent = fileDescriptorPath(parentHandle)
  const resolvedParent = yield* filesystemOperation(
    "upload.resolveParentDescriptor",
    () => realpath(anchoredParent)
  )
  yield* ensureContained(root, resolvedParent)
  const target = resolve(anchoredParent, name)
  const existing = yield* optionalFileMetadata(target)
  if (existing && !existing.isFile()) {
    return yield* filesystemFailure(
      "not_a_file",
      "upload",
      "Path is not a file"
    )
  }
  const mode = existing ? existing.mode & 0o777 : 0o644
  const temporary = resolve(anchoredParent, `.kiln-upload-${randomUUID()}`)
  let size = 0
  const digest = createHash("sha256")

  yield* Effect.acquireUseRelease(
    filesystemOperation("upload.openTemporary", () =>
      open(temporary, "wx", mode)
    ),
    (file) =>
      Effect.gen(function* () {
        yield* Stream.fromAsyncIterable(source, (cause) =>
          makeFilesystemError(
            "read_failed",
            "upload.read",
            errorMessage(cause),
            cause
          )
        ).pipe(
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              size += chunk.byteLength
              if (size > MAX_TRANSFER_BYTES) {
                return yield* filesystemFailure(
                  "file_too_large",
                  "upload",
                  "Upload exceeds the 20 GiB transfer limit"
                )
              }
              digest.update(chunk)
              yield* writeFully(file, chunk, null)
            })
          )
        )
        yield* filesystemOperation("upload.sync", () => file.sync()).pipe(
          Effect.uninterruptible
        )
        const currentParent = yield* filesystemOperation(
          "upload.verifyParent",
          () => realpath(anchoredParent)
        )
        yield* ensureContained(root, currentParent)
        yield* filesystemOperation("upload.replace", () =>
          rename(temporary, target)
        ).pipe(Effect.uninterruptible)
      }),
    (file) =>
      closeHandleEffect(file, "upload.closeTemporary").pipe(
        Effect.andThen(cleanupPathEffect(temporary))
      )
  )

  const metadata = yield* filesystemOperation("upload.stat", () => stat(target))
  return {
    modifiedAt: metadata.mtime.toISOString(),
    path: requestedPath,
    sha256: digest.digest("hex"),
    size,
  }
})

function requireLinuxDescriptorAnchoring() {
  return process.platform === "linux"
    ? Effect.void
    : filesystemFailure(
        "unsupported_platform",
        "path",
        "Secure direct file transfers require a Linux Relay host"
      )
}

function writeFully(
  file: FileHandle,
  data: Uint8Array,
  position: number | null
) {
  const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  let written = 0

  const writeNext = (): Effect.Effect<void, RelayFilesystemError> =>
    Effect.suspend(() => {
      if (written >= buffer.length) return Effect.void
      return filesystemOperation("upload.write", () =>
        file.write(
          buffer,
          written,
          buffer.length - written,
          position === null ? null : position + written
        )
      ).pipe(
        // Let an in-flight driver write settle before a finalizer closes the
        // descriptor. Interruption is observed between chunks.
        Effect.uninterruptible,
        Effect.flatMap((result) => {
          if (result.bytesWritten <= 0) {
            return filesystemFailure(
              "write_incomplete",
              "upload.write",
              "Filesystem stopped before the complete upload chunk was written"
            )
          }
          written += result.bytesWritten
          return writeNext()
        })
      )
    })

  return writeNext()
}

function optionalFileMetadata(path: string) {
  return Effect.tryPromise({
    try: () => lstat(path),
    catch: (cause) => cause,
  }).pipe(
    Effect.catch((cause) =>
      isMissingFile(cause)
        ? Effect.succeed(null)
        : Effect.fail(
            makeFilesystemError(
              "io_error",
              "upload.statTarget",
              errorMessage(cause),
              cause
            )
          )
    )
  )
}

function filesystemOperation<TResult>(
  operation: string,
  run: (signal: AbortSignal) => Promise<TResult>
) {
  return Effect.tryPromise({
    try: run,
    catch: (cause) =>
      cause instanceof RelayFilesystemError
        ? cause
        : makeFilesystemError(
            "io_error",
            operation,
            errorMessage(cause),
            cause
          ),
  })
}

interface MutationEntry {
  absolute: string
  kind: "directory" | "file"
}

export interface ArchiveDownloadEntry extends MutationEntry {
  name: string
  size: number
}

const existingMutationEntry = Effect.fn("relay.files.existingMutationEntry")(
  function* (root: string, requestedPath: string) {
    const normalizedPath = requestedPath.replace(/\/+$/u, "")
    yield* validateRelativePath(normalizedPath)
    const candidate = resolve(root, normalizedPath)
    yield* ensureContained(root, candidate)
    const parent = yield* filesystemOperation("mutation.resolveParent", () =>
      realpath(dirname(candidate))
    )
    yield* ensureContained(root, parent)
    const anchoredCandidate = resolve(parent, basename(candidate))
    const metadata = yield* filesystemOperation("mutation.statSource", () =>
      lstat(anchoredCandidate)
    )
    if (metadata.isSymbolicLink()) {
      return yield* filesystemFailure(
        "unsupported_file",
        "mutation",
        "Symbolic links cannot be changed with file actions"
      )
    }
    if (!metadata.isDirectory() && !metadata.isFile()) {
      return yield* filesystemFailure(
        "unsupported_file",
        "mutation",
        "Only files and directories can be changed"
      )
    }
    const actual = yield* filesystemOperation("mutation.resolveSource", () =>
      realpath(anchoredCandidate)
    )
    yield* ensureContained(root, actual)
    return {
      absolute: actual,
      kind: metadata.isDirectory() ? "directory" : "file",
    } satisfies MutationEntry
  }
)

const mutationDestination = Effect.fn("relay.files.mutationDestination")(
  function* (root: string, requestedPath: string) {
    const normalizedPath = requestedPath.replace(/\/+$/u, "")
    yield* validateRelativePath(normalizedPath)
    const destination = resolve(root, normalizedPath)
    yield* ensureContained(root, destination)
    const parent = yield* filesystemOperation("mutation.resolveParent", () =>
      realpath(dirname(destination))
    )
    yield* ensureContained(root, parent)
    return resolve(parent, basename(destination))
  }
)

function requireMissingDestination(path: string) {
  return optionalFileMetadata(path).pipe(
    Effect.flatMap((metadata) =>
      metadata
        ? filesystemFailure(
            "target_exists",
            "mutation",
            "A file or directory already exists at the destination"
          )
        : Effect.void
    )
  )
}

function distinctMutationPaths(paths: ReadonlyArray<string>): Array<string> {
  const normalized = [
    ...new Set(paths.map((path) => path.replace(/\/+$/u, ""))),
  ]
    .filter(Boolean)
    .sort((left, right) => left.length - right.length)
  return normalized.filter(
    (path, index) =>
      !normalized
        .slice(0, index)
        .some((parent) => path.startsWith(`${parent}/`))
  )
}

const availableDuplicatePath = Effect.fn("relay.files.availableDuplicatePath")(
  function* (root: string, requestedPath: string) {
    const normalizedPath = requestedPath.replace(/\/+$/u, "")
    const extension = extname(normalizedPath)
    const stem = extension
      ? normalizedPath.slice(0, -extension.length)
      : normalizedPath
    for (let copy = 1; copy <= 1_000; copy += 1) {
      const suffix = copy === 1 ? " copy" : ` copy ${copy}`
      const candidate = resolve(root, `${stem}${suffix}${extension}`)
      yield* ensureContained(root, candidate)
      const metadata = yield* optionalFileMetadata(candidate)
      if (!metadata) return candidate
    }
    return yield* filesystemFailure(
      "target_exists",
      "mutation.duplicate",
      "Could not find an available duplicate name"
    )
  }
)

const collectArchiveEntries = Effect.fn("relay.files.collectArchiveEntries")(
  function* (root: string, requestedPaths: ReadonlyArray<string>) {
    const entries: Array<ArchiveDownloadEntry> = []
    let totalSize = 0

    const visit = (
      entry: MutationEntry,
      name: string
    ): Effect.Effect<void, RelayFilesystemError> =>
      Effect.gen(function* () {
        const metadata = yield* filesystemOperation("archive.stat", () =>
          stat(entry.absolute)
        )
        if (entries.length >= MAX_ARCHIVE_ITEMS) {
          return yield* filesystemFailure(
            "archive_too_large",
            "mutation.archive",
            `Archives cannot contain more than ${MAX_ARCHIVE_ITEMS.toLocaleString("en-US")} entries`
          )
        }
        if (entry.kind === "file") {
          totalSize += metadata.size
          if (totalSize > MAX_TRANSFER_BYTES) {
            return yield* filesystemFailure(
              "archive_too_large",
              "mutation.archive",
              "Archive contents exceed the 20 GiB transfer limit"
            )
          }
        }
        entries.push({ ...entry, name, size: metadata.size })
        if (entry.kind === "file") return
        const children = yield* filesystemOperation(
          "archive.readDirectory",
          async () => {
            const values = []
            for await (const child of await opendir(entry.absolute))
              values.push(child)
            return values.sort((left, right) =>
              left.name.localeCompare(right.name)
            )
          }
        )
        yield* Effect.forEach(
          children,
          (child) =>
            existingMutationEntry(
              root,
              relative(root, resolve(entry.absolute, child.name))
            ).pipe(
              Effect.flatMap((resolved) =>
                visit(resolved, `${name}/${child.name}`)
              )
            ),
          { discard: true }
        )
      })

    for (const path of requestedPaths) {
      const entry = yield* existingMutationEntry(root, path)
      yield* visit(entry, basename(path))
    }
    return entries
  }
)

function writeZipArchive(
  destination: string,
  entries: ReadonlyArray<ArchiveDownloadEntry>,
  signal: AbortSignal
): Promise<void> {
  return new Promise((resolveArchive, reject) => {
    const archive = new ZipStream({
      forceZip64: entries.some((entry) => entry.size > 0xffffffff),
      zlib: { level: zlibConstants.Z_BEST_SPEED },
    })
    const output = createWriteStream(destination, { flags: "wx" })
    let activeSource: ReturnType<typeof createReadStream> | null = null
    let settled = false
    const cleanup = () => {
      signal.removeEventListener("abort", aborted)
      archive.off("error", failed)
      output.off("error", failed)
      output.off("close", finished)
      activeSource?.off("error", failed)
    }
    const finish = (cause?: Error) => {
      if (settled) return
      settled = true
      cleanup()
      if (cause) reject(cause)
      else resolveArchive()
    }
    const failed = (cause: Error) => {
      if (settled) return
      activeSource?.destroy()
      archive.destroy()
      output.destroy()
      finish(cause)
    }
    const finished = () => finish()
    const aborted = () => {
      archive.destroy()
      output.destroy()
      finish(new Error("Archive creation was cancelled"))
    }
    signal.addEventListener("abort", aborted, { once: true })
    archive.once("error", failed)
    output.once("error", failed)
    output.once("close", finished)
    archive.pipe(output)

    const append = (index: number) => {
      if (settled) return
      const entry = entries[index]
      if (!entry) {
        archive.finalize()
        return
      }
      if (entry.kind === "directory") {
        archive.entry(null, { name: `${entry.name}/` }, (cause) => {
          if (cause) failed(cause)
          else append(index + 1)
        })
        return
      }
      const source = createReadStream(entry.absolute)
      activeSource = source
      source.once("error", failed)
      archive.entry(source, { name: entry.name }, (cause) => {
        source.off("error", failed)
        activeSource = null
        if (cause) failed(cause)
        else append(index + 1)
      })
    }
    append(0)
  })
}

function closeHandleEffect(file: FileHandle, operation: string) {
  return filesystemOperation(operation, () => file.close()).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Relay filesystem handle cleanup failed", cause)
    )
  )
}

function cleanupPathEffect(path: string) {
  return filesystemOperation("cleanup.temporary", () =>
    rm(path, { force: true })
  ).pipe(
    Effect.catch((cause) =>
      Effect.logWarning("Relay temporary-file cleanup failed", cause)
    )
  )
}

function prepareFileWrite(
  lowerPath: string,
  current: Buffer,
  content: string,
  force: boolean
) {
  return Effect.tryPromise({
    try: async () => {
      if (lowerPath.endsWith(".snbt")) {
        if (!force) parseSnbt(content)
        return Buffer.from(content, "utf8")
      }

      if (!isBinaryNbtPath(lowerPath)) return Buffer.from(content, "utf8")

      const compressed = isGzip(current)
      const decodedCurrent = compressed
        ? await gunzipAsync(current, {
            maxOutputLength: MAX_FILE_BYTES,
          })
        : current
      const currentNbt = tryDecodeNbt(decodedCurrent)

      const rawText = currentNbt ? null : decodeUtf8(decodedCurrent)
      const rawSnbt = rawText !== null && looksLikeSnbt(rawText)
      if (!currentNbt && !rawSnbt) return Buffer.from(content, "utf8")

      const converted = Result.try(() => {
        const tag = parseSnbt(content, { binaryCompatible: true })
        return encodeNbt({ name: currentNbt?.name ?? "", tag })
      })
      if (Result.isFailure(converted)) {
        if (force) {
          const rawContent = Buffer.from(content, "utf8")
          return compressed
            ? gzipAsync(rawContent, { level: zlibConstants.Z_BEST_SPEED })
            : rawContent
        }
        throw converted.failure
      }
      return compressed
        ? gzipAsync(converted.success, { level: zlibConstants.Z_BEST_SPEED })
        : converted.success
    },
    catch: (cause) =>
      makeFilesystemError(
        "invalid_snbt",
        "write.nbt",
        cause instanceof Error
          ? cause.message
          : "The edited SNBT could not be encoded",
        cause
      ),
  })
}

function isBinaryNbtPath(lowerPath: string) {
  return (
    lowerPath.endsWith(".dat") ||
    lowerPath.endsWith(".dat_old") ||
    lowerPath.endsWith(".nbt")
  )
}

function isGzip(source: Uint8Array) {
  return source[0] === 0x1f && source[1] === 0x8b
}

function tryDecodeNbt(source: Uint8Array) {
  return Result.getOrNull(Result.try(() => decodeNbt(source)))
}

function decodeUtf8(source: Uint8Array) {
  return Result.getOrNull(
    Result.try(() => new TextDecoder("utf-8", { fatal: true }).decode(source))
  )
}

function looksLikeSnbt(source: string) {
  const first = source.trimStart()[0]
  return first === "{" || first === "["
}

function filesystemFailure(code: string, operation: string, reason: string) {
  return Effect.fail(makeFilesystemError(code, operation, reason))
}

function makeFilesystemError(
  code: string,
  operation: string,
  reason: string,
  cause?: unknown
) {
  return RelayFilesystemError.make({
    code,
    operation,
    reason,
    ...(cause === undefined ? {} : { cause }),
  })
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : "Filesystem operation failed"
}

function isMissingFile(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "ENOENT"
  )
}

function isAlreadyExists(cause: unknown): boolean {
  return Boolean(
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    cause.code === "EEXIST"
  )
}

function validateRelativePath(path: string) {
  if (
    path &&
    !path.includes("\0") &&
    !path.startsWith("/") &&
    !path.split(/[\\/]/u).includes("..")
  ) {
    return Effect.void
  }
  return filesystemFailure("invalid_path", "path", "Invalid relative path")
}

function ensureContained(root: string, candidate: string) {
  const normalizedRoot = resolve(root)
  const normalizedCandidate = resolve(candidate)
  return normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
    ? Effect.void
    : filesystemFailure(
        "path_outside_instance",
        "path",
        "Path resolves outside the instance directory"
      )
}
