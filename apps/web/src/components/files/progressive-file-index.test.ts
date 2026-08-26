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
  it("fills directory sizes without blocking the directory page", async () => {
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
    resolveSizes?.({
      instanceId: "instance-1",
      pending: [],
      sizes: { "world/": 3_072 },
    })
    await vi.waitFor(() =>
      expect(index.getDirectorySnapshot("").entries[0]?.size).toBe(3_072)
    )
    index.dispose()
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
})
