import type { RelayDirectoryPage, RelayFileEntry } from "@workspace/contracts"
import { Effect, Result } from "effect"

import { ensuringPromise, promiseEffect } from "@/effect/promise"
import {
  getRelayDirectoryPage,
  getRelayDirectorySizes,
  searchRelayFiles,
} from "@/server/relay"

const emptyEntries: ReadonlyArray<RelayFileEntry> = []
const fileTreeInitialLoadingDelayMs = 160
const directorySizePollInitialDelayMs = 1_000
const directorySizePollMaxDelayMs = 10_000
const directorySizePollMaxAttempts = 30
const emptyDirectorySnapshot: FileDirectorySnapshot = {
  complete: false,
  entries: emptyEntries,
  error: null,
  loading: false,
}

export interface FileDirectorySnapshot {
  complete: boolean
  entries: ReadonlyArray<RelayFileEntry>
  error: Error | null
  loading: boolean
}

export interface FileIndexStatusSnapshot {
  refreshing: boolean
  searchComplete: boolean
  searching: boolean
}

export type FileIndexPathEvent =
  | { entries: ReadonlyArray<RelayFileEntry>; type: "add" }
  | { directory: string; hasMore: boolean; type: "directory-pagination" }
  | { entries: ReadonlyArray<RelayFileEntry>; type: "reset" }

interface MutableDirectorySnapshot extends FileDirectorySnapshot {
  cursor: string | null | undefined
}

const initialStatus: FileIndexStatusSnapshot = {
  refreshing: false,
  searchComplete: true,
  searching: false,
}

export class ProgressiveFileIndex {
  readonly #instanceId: string
  readonly #relayId: string
  readonly #directories = new Map<string, MutableDirectorySnapshot>()
  readonly #directoryListeners = new Map<string, Set<() => void>>()
  readonly #directorySizes = new Map<string, number>()
  readonly #directorySizeListeners = new Map<string, Set<() => void>>()
  readonly #directorySizePolls = new Set<ReturnType<typeof setTimeout>>()
  readonly #knownEntries = new Map<string, RelayFileEntry>()
  readonly #pathListeners = new Set<(event: FileIndexPathEvent) => void>()
  readonly #statusListeners = new Set<() => void>()
  readonly #loads = new Map<string, Promise<void>>()
  readonly #treePendingDirectories = new Set<string>()
  readonly #treeLoadingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #disposed = false
  #epoch = 0
  #searchGeneration = 0
  #status = initialStatus

  constructor({
    initialRoot,
    instanceId,
    relayId,
  }: {
    initialRoot: RelayDirectoryPage | null
    instanceId: string
    relayId: string
  }) {
    this.#instanceId = instanceId
    this.#relayId = relayId
    if (initialRoot) this.#applyDirectoryPage(initialRoot)
  }

  start(): void {
    if (this.#disposed) return
    if (!this.#directories.has("")) void this.ensureDirectory("")
  }

  hydrateRoot(page: RelayDirectoryPage): void {
    if (this.#disposed || normalizeDirectoryPath(page.directory)) return
    if (this.#directories.has("")) return
    this.#applyDirectoryPage(page)
  }

  dispose(): void {
    this.#disposed = true
    this.#epoch += 1
    this.#searchGeneration += 1
    this.#directoryListeners.clear()
    this.#directorySizeListeners.clear()
    this.#pathListeners.clear()
    this.#statusListeners.clear()
    this.#loads.clear()
    this.#clearDirectorySizePolls()
    this.#clearTreeLoadingTimers()
    this.#treePendingDirectories.clear()
  }

  refresh(): void {
    if (this.#disposed) return
    const activeDirectories = [...this.#directoryListeners.keys()]
    this.#epoch += 1
    this.#searchGeneration += 1
    this.#directories.clear()
    this.#directorySizes.clear()
    this.#knownEntries.clear()
    this.#loads.clear()
    this.#clearDirectorySizePolls()
    this.#clearTreeLoadingTimers()
    this.#treePendingDirectories.clear()
    this.#setStatus({ ...initialStatus, refreshing: true })
    this.#pathListeners.forEach((listener) =>
      listener({ entries: emptyEntries, type: "reset" })
    )
    this.#directoryListeners.forEach((listeners) =>
      listeners.forEach((listener) => listener())
    )
    this.#directorySizeListeners.forEach((listeners) =>
      listeners.forEach((listener) => listener())
    )
    const epoch = this.#epoch
    const reloads = [...new Set(["", ...activeDirectories])].map((directory) =>
      this.ensureDirectory(directory)
    )
    void Promise.allSettled(reloads).then(() => {
      if (!this.#disposed && epoch === this.#epoch) {
        this.#setStatus({ ...this.#status, refreshing: false })
      }
    })
  }

  getPaths(): ReadonlyArray<string> {
    return [...this.#knownEntries.keys()]
  }

  getTreePendingDirectories(): ReadonlyArray<string> {
    return [...this.#treePendingDirectories]
  }

  addEntry(entry: RelayFileEntry): void {
    if (!this.#disposed) this.#discover([entry])
  }

  getDirectorySnapshot(directory: string): FileDirectorySnapshot {
    return (
      this.#directories.get(normalizeDirectoryPath(directory)) ??
      emptyDirectorySnapshot
    )
  }

  getDirectorySize(path: string): number | null {
    return this.#directorySizes.get(normalizeDirectoryPath(path)) ?? null
  }

  getStatusSnapshot(): FileIndexStatusSnapshot {
    return this.#status
  }

  subscribeDirectory(directory: string, listener: () => void): () => void {
    const normalized = normalizeDirectoryPath(directory)
    const listeners = this.#directoryListeners.get(normalized) ?? new Set()
    listeners.add(listener)
    this.#directoryListeners.set(normalized, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.#directoryListeners.delete(normalized)
    }
  }

  subscribeDirectorySize(path: string, listener: () => void): () => void {
    const normalized = normalizeDirectoryPath(path)
    const listeners = this.#directorySizeListeners.get(normalized) ?? new Set()
    listeners.add(listener)
    this.#directorySizeListeners.set(normalized, listeners)
    return () => {
      listeners.delete(listener)
      if (!listeners.size) this.#directorySizeListeners.delete(normalized)
    }
  }

  subscribePaths(listener: (event: FileIndexPathEvent) => void): () => void {
    this.#pathListeners.add(listener)
    if (this.#knownEntries.size) {
      listener({ entries: [...this.#knownEntries.values()], type: "add" })
    }
    return () => this.#pathListeners.delete(listener)
  }

  subscribeStatus(listener: () => void): () => void {
    this.#statusListeners.add(listener)
    return () => this.#statusListeners.delete(listener)
  }

  ensureDirectory(directory: string): Promise<void> {
    const normalized = normalizeDirectoryPath(directory)
    const existing = this.#directories.get(normalized)
    if (existing && !existing.error) return Promise.resolve()
    this.#scheduleTreeDirectoryLoading(normalized)
    return this.#loadNextDirectoryPage(normalized)
  }

  loadMoreDirectory(directory: string): Promise<void> {
    const normalized = normalizeDirectoryPath(directory)
    const snapshot = this.#directories.get(normalized)
    if (snapshot?.complete) return Promise.resolve()
    this.#setTreeDirectoryHasMore(normalized, true)
    return this.#loadNextDirectoryPage(normalized)
  }

  #loadNextDirectoryPage(directory: string): Promise<void> {
    const active = this.#loads.get(directory)
    if (active) return active

    const epoch = this.#epoch
    const load = ensuringPromise(
      () => this.#loadDirectoryPage(directory, epoch),
      () => {
        if (this.#loads.get(directory) === load) this.#loads.delete(directory)
      }
    )
    this.#loads.set(directory, load)
    return load
  }

  search(query: string): void {
    const normalizedQuery = query.trim()
    const generation = ++this.#searchGeneration
    if (!normalizedQuery) {
      this.#setStatus({
        ...this.#status,
        searchComplete: true,
        searching: false,
      })
      return
    }

    this.#setStatus({
      ...this.#status,
      searchComplete: false,
      searching: true,
    })
    void this.#runSearch(normalizedQuery, generation)
  }

  async #loadDirectoryPage(directory: string, epoch: number): Promise<void> {
    const previous = this.#directories.get(directory)
    this.#setDirectory(directory, {
      complete: previous?.complete ?? false,
      cursor: previous?.cursor,
      entries: previous?.entries ?? emptyEntries,
      error: null,
      loading: true,
    })

    const result = await promiseResult(() =>
      getRelayDirectoryPage({
        data: {
          ...(previous?.cursor ? { cursor: previous.cursor } : {}),
          instanceId: this.#instanceId,
          path: directory,
          relayId: this.#relayId,
        },
      })
    )
    if (this.#disposed || epoch !== this.#epoch) return
    if (Result.isSuccess(result)) {
      this.#applyDirectoryPage(result.success)
      return
    }
    this.#cancelTreeDirectoryLoading(directory)
    this.#setTreeDirectoryHasMore(directory, false)
    const snapshot = this.#directories.get(directory)
    this.#setDirectory(directory, {
      complete: false,
      cursor: undefined,
      entries: snapshot?.entries ?? emptyEntries,
      error:
        result.failure instanceof Error
          ? result.failure
          : new Error(String(result.failure)),
      loading: false,
    })
  }

  #applyDirectoryPage(page: RelayDirectoryPage): void {
    const directory = normalizeDirectoryPath(page.directory)
    this.#cancelTreeDirectoryLoading(directory)
    const previous = this.#directories.get(directory)
    const entries = mergeEntries(
      previous?.entries ?? emptyEntries,
      page.entries
    )
    for (const entry of page.entries) {
      if (entry.kind === "directory" && entry.size !== null) {
        this.#setDirectorySize(entry.path, entry.size)
      }
    }
    this.#setDirectory(directory, {
      complete: page.cursor === null,
      cursor: page.cursor,
      entries,
      error: null,
      loading: false,
    })
    this.#discover(page.entries)
    void this.#loadDirectorySizes(
      directory,
      page.entries.flatMap((entry) =>
        entry.kind === "directory" ? [entry.path] : []
      ),
      this.#epoch
    )
    this.#setTreeDirectoryHasMore(directory, page.cursor !== null)
  }

  async #loadDirectorySizes(
    directory: string,
    paths: ReadonlyArray<string>,
    epoch: number,
    pollAttempt = 0,
    backoffAttempt = 0
  ): Promise<void> {
    if (!paths.length || this.#disposed || epoch !== this.#epoch) return
    const result = await promiseResult(() =>
      getRelayDirectorySizes({
        data: {
          instanceId: this.#instanceId,
          paths: [...paths],
          relayId: this.#relayId,
        },
      })
    )
    if (this.#disposed || epoch !== this.#epoch || Result.isFailure(result)) {
      return
    }
    const sizesChanged = this.#applyDirectorySizes(
      directory,
      result.success.sizes
    )
    if (
      !result.success.pending.length ||
      pollAttempt >= directorySizePollMaxAttempts
    ) {
      return
    }
    const madeProgress =
      sizesChanged || !sameDirectorySizePaths(paths, result.success.pending)
    const nextBackoffAttempt = madeProgress ? 0 : backoffAttempt + 1
    const delay = Math.min(
      directorySizePollInitialDelayMs *
        2 ** (madeProgress ? 0 : backoffAttempt),
      directorySizePollMaxDelayMs
    )
    const timer = setTimeout(() => {
      this.#directorySizePolls.delete(timer)
      void this.#loadDirectorySizes(
        directory,
        result.success.pending,
        epoch,
        pollAttempt + 1,
        nextBackoffAttempt
      )
    }, delay)
    this.#directorySizePolls.add(timer)
  }

  #applyDirectorySizes(
    directory: string,
    sizes: Readonly<Record<string, number>>
  ): boolean {
    const snapshot = this.#directories.get(directory)
    if (!snapshot) return false
    let changed = false
    for (const entry of snapshot.entries) {
      const size = sizes[entry.path]
      if (
        entry.kind !== "directory" ||
        size === undefined ||
        !this.#setDirectorySize(entry.path, size)
      ) {
        continue
      }
      changed = true
    }
    return changed
  }

  #setDirectorySize(path: string, size: number): boolean {
    const normalized = normalizeDirectoryPath(path)
    if (size === this.#directorySizes.get(normalized)) return false
    this.#directorySizes.set(normalized, size)
    this.#directorySizeListeners
      .get(normalized)
      ?.forEach((listener) => listener())
    return true
  }

  #discover(entries: ReadonlyArray<RelayFileEntry>): void {
    const additions: Array<RelayFileEntry> = []
    for (const entry of entries) {
      if (this.#knownEntries.has(entry.path)) continue
      this.#knownEntries.set(entry.path, entry)
      additions.push(entry)
    }
    if (!additions.length) return
    this.#pathListeners.forEach((listener) =>
      listener({ entries: additions, type: "add" })
    )
  }

  async #runSearch(query: string, generation: number): Promise<void> {
    let cursor: string | undefined
    do {
      const result = await promiseResult(() =>
        searchRelayFiles({
          data: {
            ...(cursor ? { cursor } : {}),
            instanceId: this.#instanceId,
            query,
            relayId: this.#relayId,
          },
        })
      )
      if (this.#disposed || generation !== this.#searchGeneration) return
      if (Result.isFailure(result)) {
        this.#setStatus({
          ...this.#status,
          searchComplete: false,
          searching: false,
        })
        return
      }
      this.#discover(result.success.entries)
      cursor = result.success.cursor ?? undefined
    } while (cursor)
    this.#setStatus({
      ...this.#status,
      searchComplete: true,
      searching: false,
    })
  }

  #setDirectory(directory: string, snapshot: MutableDirectorySnapshot): void {
    this.#directories.set(directory, snapshot)
    this.#directoryListeners.get(directory)?.forEach((listener) => listener())
  }

  #setStatus(status: FileIndexStatusSnapshot): void {
    if (
      status.refreshing === this.#status.refreshing &&
      status.searchComplete === this.#status.searchComplete &&
      status.searching === this.#status.searching
    ) {
      return
    }
    this.#status = status
    this.#statusListeners.forEach((listener) => listener())
  }

  #setTreeDirectoryHasMore(directory: string, hasMore: boolean): void {
    const changed = hasMore
      ? !this.#treePendingDirectories.has(directory)
      : this.#treePendingDirectories.has(directory)
    if (!changed) return
    if (hasMore) this.#treePendingDirectories.add(directory)
    else this.#treePendingDirectories.delete(directory)
    this.#pathListeners.forEach((listener) =>
      listener({ directory, hasMore, type: "directory-pagination" })
    )
  }

  #scheduleTreeDirectoryLoading(directory: string): void {
    if (this.#treeLoadingTimers.has(directory)) return
    const timer = setTimeout(() => {
      if (this.#treeLoadingTimers.get(directory) !== timer) return
      this.#treeLoadingTimers.delete(directory)
      if (!this.#disposed) this.#setTreeDirectoryHasMore(directory, true)
    }, fileTreeInitialLoadingDelayMs)
    this.#treeLoadingTimers.set(directory, timer)
  }

  #cancelTreeDirectoryLoading(directory: string): void {
    const timer = this.#treeLoadingTimers.get(directory)
    if (timer === undefined) return
    clearTimeout(timer)
    this.#treeLoadingTimers.delete(directory)
  }

  #clearTreeLoadingTimers(): void {
    this.#treeLoadingTimers.forEach((timer) => clearTimeout(timer))
    this.#treeLoadingTimers.clear()
  }

  #clearDirectorySizePolls(): void {
    this.#directorySizePolls.forEach((timer) => clearTimeout(timer))
    this.#directorySizePolls.clear()
  }
}

function promiseResult<TResult>(run: () => Promise<TResult>) {
  return Effect.runPromise(Effect.result(promiseEffect(run)))
}

function normalizeDirectoryPath(path: string): string {
  const normalized = path.replace(/^\/+|\/+$/gu, "")
  return normalized ? `${normalized}/` : ""
}

function sameDirectorySizePaths(
  left: ReadonlyArray<string>,
  right: ReadonlyArray<string>
): boolean {
  if (left.length !== right.length) return false
  const rightPaths = new Set(right)
  return left.every((path) => rightPaths.has(path))
}

function mergeEntries(
  current: ReadonlyArray<RelayFileEntry>,
  incoming: ReadonlyArray<RelayFileEntry>
): ReadonlyArray<RelayFileEntry> {
  const entries = new Map(current.map((entry) => [entry.path, entry]))
  incoming.forEach((entry) => entries.set(entry.path, entry))
  return [...entries.values()].sort((left, right) => {
    if (left.kind !== right.kind) return left.kind === "directory" ? -1 : 1
    return left.path.localeCompare(right.path)
  })
}
