import { afterEach, describe, expect, it, vi } from "vite-plus/test"
import { QueryClient, QueryObserver } from "@tanstack/react-query"
import {
  relayDirectorySizesInputSchema,
  type RelayDirectoryPage,
  type RelayFileEntry,
} from "@workspace/contracts"

const relay = vi.hoisted(() => ({
  getRelayDirectoryPage: vi.fn(),
  getRelayDirectorySizes: vi.fn(),
  searchRelayFiles: vi.fn(),
}))
vi.mock("@/server/relay", () => relay)
import { FileTreeIndex } from "@/components/files/file-tree-index"
import {
  directorySizeBatches,
  refreshFileQueries,
  relayDirectorySizesQueryOptions,
} from "@/components/files/file-query-options"

const clients: Array<QueryClient> = []
function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  clients.push(queryClient)
  return {
    queryClient,
    index: new FileTreeIndex({
      queryClient,
      instanceId: "instance-1",
      relayId: "relay-1",
    }),
  }
}
function entry(path: string): RelayFileEntry {
  return {
    path,
    kind: path.endsWith("/") ? "directory" : "file",
    modifiedAt: 1,
    size: null,
  }
}
function page(
  entries: Array<RelayFileEntry>,
  directory = "",
  cursor: string | null = null
): RelayDirectoryPage {
  return { cursor, directory, entries, instanceId: "instance-1" }
}
afterEach(() => {
  for (const client of clients.splice(0)) client.clear()
  vi.resetAllMocks()
  vi.useRealTimers()
})

describe("Files query cache", () => {
  it("recovers failed tree loads without hiding Query's error state and can retry", async () => {
    vi.useFakeTimers()
    const { queryClient, index } = setup()
    const release = index.subscribePaths(vi.fn())
    const failure = new Error("Relay unavailable")
    relay.getRelayDirectoryPage.mockRejectedValue(failure)
    const loading = index.ensureDirectory("world/")
    await vi.runAllTimersAsync()
    await expect(loading).resolves.toBeUndefined()
    expect(
      queryClient.getQueryState(index.directoryOptions("world/").queryKey)
    ).toMatchObject({ status: "error", error: failure })
    expect(index.getPaths()).toEqual([])

    relay.getRelayDirectoryPage.mockResolvedValue(
      page([entry("world/level.dat")], "world/")
    )
    await index.ensureDirectory("world/")
    expect(index.getPaths()).toEqual(["world/level.dat"])
    release()
  })
  it("refreshes an initially empty root after tree effects replay", async () => {
    const { queryClient, index } = setup()
    relay.getRelayDirectoryPage.mockResolvedValueOnce(page([]))
    await index.ensureDirectory("")
    const release = index.subscribePaths(vi.fn())
    release()
    const listener = vi.fn()
    const releaseReplayed = index.subscribePaths(listener)
    relay.getRelayDirectoryPage.mockResolvedValueOnce(
      page([entry("server.properties")])
    )
    await refreshFileQueries(queryClient, "relay-1", "instance-1")
    expect(index.getPaths()).toEqual(["server.properties"])
    expect(listener).toHaveBeenCalledWith({
      type: "add",
      entries: [entry("server.properties")],
    })
    releaseReplayed()
  })
  it("shares directory requests and refreshes cursor pages without keeping deleted paths", async () => {
    const { queryClient, index } = setup()
    const release = index.subscribePaths(vi.fn())
    relay.getRelayDirectoryPage.mockResolvedValueOnce(
      page([entry("old.txt")], "", "next-page")
    )
    await Promise.all([
      index.ensureDirectory(""),
      queryClient.fetchInfiniteQuery(index.directoryOptions("")),
    ])
    expect(relay.getRelayDirectoryPage).toHaveBeenCalledTimes(1)
    relay.getRelayDirectoryPage.mockResolvedValueOnce(page([entry("keep.txt")]))
    await index.loadMoreDirectory("")
    expect(relay.getRelayDirectoryPage.mock.calls[1]?.[0].data.cursor).toBe(
      "next-page"
    )
    relay.getRelayDirectoryPage.mockResolvedValueOnce(
      page([entry("keep.txt"), entry("new.txt")])
    )
    await refreshFileQueries(queryClient, "relay-1", "instance-1")
    expect(
      [...index.getPaths()].sort((left, right) => left.localeCompare(right))
    ).toEqual(["keep.txt", "new.txt"])
    expect(
      queryClient.getQueryData(index.directoryOptions("").queryKey)?.pages
    ).toHaveLength(1)
    release()
  })
  it("removes replaced page entries while retaining search discoveries beyond loaded pages", async () => {
    const { queryClient, index } = setup()
    const release = index.subscribePaths(vi.fn())
    relay.getRelayDirectoryPage.mockResolvedValueOnce(
      page([entry("old.txt")], "", "next-page")
    )
    await index.ensureDirectory("")
    index.addEntry(entry("search-discovery.txt"))
    relay.getRelayDirectoryPage.mockResolvedValueOnce(
      page([entry("new.txt")], "", "next-page")
    )
    await refreshFileQueries(queryClient, "relay-1", "instance-1")
    expect(
      [...index.getPaths()].sort((left, right) => left.localeCompare(right))
    ).toEqual(["new.txt", "search-discovery.txt"])
    release()
  })
  it("removes deleted folders and their cached descendants", async () => {
    const { queryClient, index } = setup()
    relay.getRelayDirectoryPage.mockImplementation(({ data }) =>
      Promise.resolve(
        data.path
          ? page([entry("world/level.dat")], "world/")
          : page([entry("world/")])
      )
    )
    await index.ensureDirectory("")
    const release = index.subscribePaths(vi.fn())
    await index.ensureDirectory("world/")
    expect(index.getPaths()).toContain("world/level.dat")
    relay.getRelayDirectoryPage.mockResolvedValue(page([]))
    await refreshFileQueries(queryClient, "relay-1", "instance-1")
    expect(index.getPaths()).toEqual([])
    expect(
      queryClient.getQueryData(index.directoryOptions("world/").queryKey)
    ).toBeUndefined()
    release()
    const replay = vi.fn()
    const releaseReplayed = index.subscribePaths(replay)
    expect(replay).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "add" })
    )
    releaseReplayed()
  })
  it("does not update an unmounted tree when a shared request finishes", async () => {
    const { index } = setup()
    let resolve: ((value: RelayDirectoryPage) => void) | undefined
    relay.getRelayDirectoryPage.mockReturnValueOnce(
      new Promise<RelayDirectoryPage>((done) => {
        resolve = done
      })
    )
    const listener = vi.fn()
    const release = index.subscribePaths(listener)
    const load = index.ensureDirectory("")
    release()
    resolve?.(page([entry("late.txt")]))
    await load
    expect(listener).not.toHaveBeenCalled()
    expect(index.getPaths()).toEqual([])
  })
  it("polls only pending sizes, preserves ready sizes, and notifies only changed cells", async () => {
    const { queryClient } = setup()
    const options = relayDirectorySizesQueryOptions(
      queryClient,
      "relay-1",
      "instance-1",
      ["ready/", "pending/"]
    )
    relay.getRelayDirectorySizes.mockResolvedValueOnce({
      instanceId: "instance-1",
      pending: ["pending/"],
      sizes: { "ready/": 42 },
    })
    await queryClient.fetchQuery(options)
    const observer = new QueryObserver(queryClient, {
      ...options,
      enabled: false,
      refetchInterval: false,
      notifyOnChangeProps: ["data"],
      select: (data) => data.sizes["ready/"],
    })
    const listener = vi.fn()
    const release = observer.subscribe(listener)
    relay.getRelayDirectorySizes.mockResolvedValueOnce({
      instanceId: "instance-1",
      pending: [],
      sizes: { "pending/": 84 },
    })
    const result = await queryClient.fetchQuery({ ...options, staleTime: 0 })
    expect(relay.getRelayDirectorySizes.mock.calls[1]?.[0].data.paths).toEqual([
      "pending/",
    ])
    expect(result.sizes).toEqual({ "ready/": 42, "pending/": 84 })
    expect(listener).not.toHaveBeenCalled()
    release()
  })
  it("stops polling sizes that never finish, resumes after refresh, and batches within the Relay limit", async () => {
    const { queryClient } = setup()
    const paths = ["pending/"]
    const options = relayDirectorySizesQueryOptions(
      queryClient,
      "relay-1",
      "instance-1",
      paths
    )
    relay.getRelayDirectorySizes.mockResolvedValue({
      instanceId: "instance-1",
      pending: paths,
      sizes: {},
    })
    const query = new QueryObserver(queryClient, options).getCurrentQuery()
    const polling = () =>
      typeof options.refetchInterval === "function" &&
      options.refetchInterval(query) !== false
    await queryClient.fetchQuery(options)
    expect(polling()).toBe(true)
    let attempts = 0
    while (polling() && attempts++ < 1_000)
      await queryClient.fetchQuery({ ...options, staleTime: 0 })
    expect(polling()).toBe(false)

    await queryClient.invalidateQueries({
      queryKey: options.queryKey,
      refetchType: "none",
    })
    await queryClient.fetchQuery(options)
    expect(polling()).toBe(true)

    const directories = Array.from({ length: 300 }, (_, index) =>
      entry(`directory-${index}/`)
    )
    const batches = directorySizeBatches(directories)
    for (const batch of batches) {
      expect(
        relayDirectorySizesInputSchema.safeParse({
          instanceId: "a".repeat(40),
          paths: batch,
        }).success
      ).toBe(true)
    }
    expect(batches.flat()).toHaveLength(directories.length)
  })
})
