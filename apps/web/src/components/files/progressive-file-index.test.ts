import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const relay = vi.hoisted(() => ({
  getRelayDirectoryPage: vi.fn(),
  getRelayDirectorySizes: vi.fn(),
  searchRelayFiles: vi.fn(),
}))

vi.mock("@/server/relay", () => relay)

import { ProgressiveFileIndex } from "@/components/files/progressive-file-index"

afterEach(() => {
  vi.resetAllMocks()
})

describe("ProgressiveFileIndex", () => {
  it("fills sizes while notifying only the affected directory", async () => {
    let resolveSizes:
      | ((value: {
          instanceId: string
          pending: Array<string>
          sizes: Record<string, number>
        }) => void)
      | undefined
    relay.getRelayDirectoryPage.mockResolvedValueOnce({
      cursor: null,
      directory: "",
      entries: [
        {
          kind: "directory",
          modifiedAt: 1,
          path: "world/",
          size: null,
        },
      ],
      instanceId: "instance-1",
    })
    relay.getRelayDirectorySizes.mockReturnValueOnce(
      new Promise((resolve) => {
        resolveSizes = resolve
      })
    )
    const index = new ProgressiveFileIndex({
      initialRoot: null,
      instanceId: "instance-1",
      relayId: "relay-1",
    })

    await index.ensureDirectory("")

    expect(index.getDirectorySnapshot("").entries[0]?.size).toBeNull()
    expect(relay.getRelayDirectorySizes).toHaveBeenCalledWith({
      data: {
        instanceId: "instance-1",
        paths: ["world/"],
        relayId: "relay-1",
      },
    })
    const rootDirectoryListener = vi.fn()
    const nestedDirectoryListener = vi.fn()
    const pathListener = vi.fn()
    const statusListener = vi.fn()
    index.subscribeDirectory("", rootDirectoryListener)
    index.subscribeDirectory("world/", nestedDirectoryListener)
    index.subscribePaths(pathListener)
    index.subscribeStatus(statusListener)
    // subscribePaths replays known entries once to initialize the tree model.
    pathListener.mockClear()

    resolveSizes?.({
      instanceId: "instance-1",
      pending: [],
      sizes: { "world/": 3_072 },
    })
    await vi.waitFor(() =>
      expect(index.getDirectorySnapshot("").entries[0]?.size).toBe(3_072)
    )
    expect(rootDirectoryListener).toHaveBeenCalledTimes(1)
    expect(nestedDirectoryListener).not.toHaveBeenCalled()
    expect(pathListener).not.toHaveBeenCalled()
    expect(statusListener).not.toHaveBeenCalled()
    index.dispose()
  })

  it("continues polling valid directories after another path disappears", async () => {
    vi.useFakeTimers()
    relay.getRelayDirectoryPage.mockResolvedValueOnce({
      cursor: null,
      directory: "",
      entries: [
        { kind: "directory", modifiedAt: 1, path: "ready/", size: null },
        { kind: "directory", modifiedAt: 1, path: "removed/", size: null },
        { kind: "directory", modifiedAt: 1, path: "slow/", size: null },
      ],
      instanceId: "instance-1",
    })
    relay.getRelayDirectorySizes
      .mockResolvedValueOnce({
        instanceId: "instance-1",
        pending: ["slow/"],
        sizes: { "ready/": 10 },
      })
      .mockResolvedValueOnce({
        instanceId: "instance-1",
        pending: [],
        sizes: { "slow/": 20 },
      })
    const index = new ProgressiveFileIndex({
      initialRoot: null,
      instanceId: "instance-1",
      relayId: "relay-1",
    })

    try {
      await index.ensureDirectory("")
      await vi.advanceTimersByTimeAsync(1_000)

      expect(relay.getRelayDirectorySizes).toHaveBeenNthCalledWith(2, {
        data: {
          instanceId: "instance-1",
          paths: ["slow/"],
          relayId: "relay-1",
        },
      })
      expect(index.getDirectorySnapshot("").entries).toMatchObject([
        { path: "ready/", size: 10 },
        { path: "removed/", size: null },
        { path: "slow/", size: 20 },
      ])
    } finally {
      index.dispose()
      vi.useRealTimers()
    }
  })

  it("stops polling directory sizes after the bounded retry window", async () => {
    vi.useFakeTimers()
    relay.getRelayDirectoryPage.mockResolvedValueOnce({
      cursor: null,
      directory: "",
      entries: [
        { kind: "directory", modifiedAt: 1, path: "slow/", size: null },
      ],
      instanceId: "instance-1",
    })
    relay.getRelayDirectorySizes.mockResolvedValue({
      instanceId: "instance-1",
      pending: ["slow/"],
      sizes: {},
    })
    const index = new ProgressiveFileIndex({
      initialRoot: null,
      instanceId: "instance-1",
      relayId: "relay-1",
    })

    try {
      await index.ensureDirectory("")
      await vi.runAllTimersAsync()

      expect(relay.getRelayDirectorySizes).toHaveBeenCalledTimes(31)
      await vi.advanceTimersByTimeAsync(60_000)
      expect(relay.getRelayDirectorySizes).toHaveBeenCalledTimes(31)
    } finally {
      index.dispose()
      vi.useRealTimers()
    }
  })

  it("retries a directory after a transient load failure", async () => {
    relay.getRelayDirectoryPage
      .mockRejectedValueOnce(new Error("Relay temporarily unavailable"))
      .mockResolvedValueOnce({
        cursor: null,
        directory: "world/",
        entries: [
          {
            kind: "file",
            modifiedAt: 1,
            path: "world/server.properties",
            size: 42,
          },
        ],
        instanceId: "instance-1",
      })
    const index = new ProgressiveFileIndex({
      initialRoot: null,
      instanceId: "instance-1",
      relayId: "relay-1",
    })

    await index.ensureDirectory("world/")
    expect(index.getDirectorySnapshot("world/").error).toBeInstanceOf(Error)

    await index.ensureDirectory("world/")

    expect(relay.getRelayDirectoryPage).toHaveBeenCalledTimes(2)
    expect(index.getDirectorySnapshot("world/")).toMatchObject({
      complete: true,
      entries: [{ path: "world/server.properties" }],
      error: null,
      loading: false,
    })
    index.dispose()
  })

  it("replays paths discovered before the file tree subscribes", async () => {
    relay.getRelayDirectoryPage.mockResolvedValueOnce({
      cursor: null,
      directory: "world/",
      entries: [
        {
          kind: "directory",
          modifiedAt: 1,
          path: "world/data/",
          size: null,
        },
        {
          kind: "file",
          modifiedAt: 1,
          path: "world/level.dat",
          size: 42,
        },
      ],
      instanceId: "instance-1",
    })
    relay.getRelayDirectorySizes.mockResolvedValueOnce({
      instanceId: "instance-1",
      pending: [],
      sizes: { "world/data/": 24 },
    })
    const index = new ProgressiveFileIndex({
      initialRoot: null,
      instanceId: "instance-1",
      relayId: "relay-1",
    })

    await index.ensureDirectory("world/")
    const events: Array<unknown> = []
    const unsubscribe = index.subscribePaths((event) => events.push(event))

    expect(events).toEqual([
      {
        entries: [
          {
            kind: "directory",
            modifiedAt: 1,
            path: "world/data/",
            size: null,
          },
          {
            kind: "file",
            modifiedAt: 1,
            path: "world/level.dat",
            size: 42,
          },
        ],
        type: "add",
      },
    ])
    unsubscribe()
    index.dispose()
  })
})
