import {
  InfiniteQueryObserver,
  type InfiniteData,
  type Query,
  type QueryClient,
} from "@tanstack/react-query"
import type { RelayDirectoryPage, RelayFileEntry } from "@workspace/contracts"
import { Effect } from "effect"

import { directoryPageEntries } from "@/components/files/file-query-options"
import { promiseEffect } from "@/effect/promise"
import { queryKeys, relayDirectoryQueryOptions } from "@/lib/query-options"

const loadingDelayMs = 160

export type FileIndexPathEvent =
  | { entries: ReadonlyArray<RelayFileEntry>; type: "add" }
  | { paths: ReadonlyArray<string>; type: "remove" }
  | { directory: string; hasMore: boolean; type: "directory-pagination" }

// Project Query's directory cache into Trees' imperative model. Only tree UI state lives here.
export class FileTreeIndex {
  readonly queryClient: QueryClient
  readonly instanceId: string
  readonly relayId: string
  readonly #entries = new Map<string, RelayFileEntry>()
  readonly #listeners = new Set<(event: FileIndexPathEvent) => void>()
  readonly #directoryPaths = new Map<string, ReadonlySet<string>>()
  readonly #pendingDirectories = new Set<string>()
  readonly #treeDirectories = new Set<string>()
  readonly #directorySubscriptions = new Map<string, () => void>()
  readonly #loadingTimers = new Map<string, ReturnType<typeof setTimeout>>()
  #unsubscribe: (() => void) | undefined

  constructor({
    queryClient,
    instanceId,
    relayId,
  }: {
    queryClient: QueryClient
    instanceId: string
    relayId: string
  }) {
    this.queryClient = queryClient
    this.instanceId = instanceId
    this.relayId = relayId
    const root = queryClient.getQueryData(this.directoryOptions("").queryKey)
    if (root) this.addEntries(directoryPageEntries(root))
  }

  directoryOptions(directory: string) {
    return relayDirectoryQueryOptions(this.relayId, this.instanceId, directory)
  }

  getPaths(): ReadonlyArray<string> {
    return [...this.#entries.keys()]
  }

  getTreePendingDirectories(): ReadonlyArray<string> {
    return [...this.#pendingDirectories]
  }

  addEntry(entry: RelayFileEntry): void {
    this.addEntries([entry])
  }

  addEntries(entries: ReadonlyArray<RelayFileEntry>): void {
    const additions = entries.filter((entry) => !this.#entries.has(entry.path))
    for (const entry of entries) this.#entries.set(entry.path, entry)
    if (additions.length) this.#emit({ entries: additions, type: "add" })
  }

  subscribePaths(listener: (event: FileIndexPathEvent) => void): () => void {
    this.#listeners.add(listener)
    if (this.#entries.size)
      listener({ entries: [...this.#entries.values()], type: "add" })
    if (!this.#unsubscribe) {
      for (const directory of this.#treeDirectories)
        this.#observeDirectory(directory)
      this.#unsubscribe = this.queryClient
        .getQueryCache()
        .subscribe((event) => {
          if (
            event.type === "updated" &&
            this.#isDirectoryQuery(event.query) &&
            (event.action.type === "success" ||
              event.action.type === "error" ||
              !event.query.state.data)
          ) {
            this.#syncDirectory(event.query)
          }
        })
      const directories = this.queryClient.getQueryCache().findAll({
        queryKey: [
          ...queryKeys.relay.tree(this.relayId, this.instanceId),
          "directory",
        ],
      })
      directories.sort(
        (left, right) =>
          String(left.queryKey[7]).length - String(right.queryKey[7]).length
      )
      for (const query of directories) this.#syncDirectory(query, true)
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size) return
      this.#unsubscribe?.()
      this.#unsubscribe = undefined
      for (const unsubscribe of this.#directorySubscriptions.values())
        unsubscribe()
      this.#directorySubscriptions.clear()
      for (const timer of this.#loadingTimers.values()) clearTimeout(timer)
      this.#loadingTimers.clear()
    }
  }

  async ensureDirectory(directory: string): Promise<void> {
    this.#treeDirectories.add(directory)
    if (this.#listeners.size) this.#observeDirectory(directory)
    await Effect.runPromise(
      promiseEffect(() =>
        this.queryClient.ensureInfiniteQueryData(
          this.directoryOptions(directory)
        )
      ).pipe(Effect.result)
    )
  }

  async loadMoreDirectory(directory: string): Promise<void> {
    const observer = new InfiniteQueryObserver(
      this.queryClient,
      this.directoryOptions(directory)
    )
    if (observer.getCurrentResult().hasNextPage)
      await observer.fetchNextPage({ cancelRefetch: false })
  }

  #observeDirectory(directory: string): void {
    if (this.#directorySubscriptions.has(directory)) return
    const observer = new InfiniteQueryObserver(
      this.queryClient,
      this.directoryOptions(directory)
    )
    this.#directorySubscriptions.set(
      directory,
      observer.subscribe(() => {})
    )
  }

  #isDirectoryQuery(query: Query): boolean {
    const key = query.queryKey
    return (
      key[0] === "relay" &&
      key[1] === this.relayId &&
      key[2] === "instances" &&
      key[3] === this.instanceId &&
      key[4] === "files" &&
      key[5] === "tree" &&
      key[6] === "directory"
    )
  }

  #syncDirectory(query: Query, replaying = false): void {
    const directory = String(query.queryKey[7])
    const data = query.state.data as
      | InfiniteData<RelayDirectoryPage>
      | undefined
    if (!data && query.state.fetchStatus === "fetching") {
      if (!this.#loadingTimers.has(directory))
        this.#loadingTimers.set(
          directory,
          setTimeout(() => {
            this.#loadingTimers.delete(directory)
            this.#setHasMore(directory, true)
          }, loadingDelayMs)
        )
      return
    }
    const timer = this.#loadingTimers.get(directory)
    if (timer) clearTimeout(timer)
    this.#loadingTimers.delete(directory)
    if (!data || query.state.status === "error") {
      this.#setHasMore(directory, false)
      return
    }
    if (replaying && !this.#directoryExists(directory)) return
    const entries = directoryPageEntries(data)
    const hasMore = data.pages.at(-1)?.cursor != null
    const current = new Set(entries.map((entry) => entry.path))
    const previous = this.#directoryPaths.get(directory) ?? new Set<string>()
    this.#directoryPaths.set(directory, current)
    const removed = [...this.#entries.keys()].filter(
      (path) =>
        parentDirectory(path) === directory &&
        !current.has(path) &&
        (!hasMore || previous.has(path))
    )
    if (removed.length) {
      for (const path of this.#entries.keys()) {
        if (
          removed.some(
            (removedPath) =>
              path === removedPath ||
              (removedPath.endsWith("/") && path.startsWith(removedPath))
          )
        )
          this.#entries.delete(path)
      }
      for (const directory of this.#treeDirectories) {
        if (
          !removed.some(
            (path) => path.endsWith("/") && directory.startsWith(path)
          )
        )
          continue
        this.#directoryPaths.delete(directory)
        this.#treeDirectories.delete(directory)
        this.#directorySubscriptions.get(directory)?.()
        this.#directorySubscriptions.delete(directory)
        const timer = this.#loadingTimers.get(directory)
        if (timer) clearTimeout(timer)
        this.#loadingTimers.delete(directory)
        this.#setHasMore(directory, false)
      }
      this.#emit({ paths: removed, type: "remove" })
      // Deleted folders must not reappear from their old cached listings on remount.
      for (const cached of this.queryClient.getQueryCache().findAll({
        queryKey: [
          ...queryKeys.relay.tree(this.relayId, this.instanceId),
          "directory",
        ],
      })) {
        if (
          removed.some(
            (path) =>
              path.endsWith("/") && String(cached.queryKey[7]).startsWith(path)
          )
        )
          this.queryClient.removeQueries({
            queryKey: cached.queryKey,
            exact: true,
          })
      }
    }
    this.addEntries(entries)
    this.#setHasMore(directory, hasMore)
  }

  #directoryExists(directory: string): boolean {
    if (!directory) return true
    const parent = parentDirectory(directory)
    const data = this.queryClient.getQueryData(
      this.directoryOptions(parent).queryKey
    )
    if (
      data &&
      data.pages.at(-1)?.cursor === null &&
      !data.pages.some((page) =>
        page.entries.some((entry) => entry.path === directory)
      )
    )
      return false
    return this.#directoryExists(parent)
  }

  #setHasMore(directory: string, hasMore: boolean): void {
    if (this.#pendingDirectories.has(directory) === hasMore) return
    if (hasMore) this.#pendingDirectories.add(directory)
    else this.#pendingDirectories.delete(directory)
    this.#emit({ directory, hasMore, type: "directory-pagination" })
  }

  #emit(event: FileIndexPathEvent): void {
    for (const listener of this.#listeners) listener(event)
  }
}

function parentDirectory(path: string): string {
  const trimmed = path.replace(/\/$/u, "")
  const separator = trimmed.lastIndexOf("/")
  return separator < 0 ? "" : trimmed.slice(0, separator + 1)
}
