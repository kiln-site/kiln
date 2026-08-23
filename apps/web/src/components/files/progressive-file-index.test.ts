import { afterEach, describe, expect, it, vi } from "vite-plus/test"

const relay = vi.hoisted(() => ({
  getRelayDirectoryPage: vi.fn(),
  searchRelayFiles: vi.fn(),
}))

vi.mock("@/server/relay", () => relay)

import { ProgressiveFileIndex } from "@/components/files/progressive-file-index"

afterEach(() => {
  vi.resetAllMocks()
})

describe("ProgressiveFileIndex", () => {
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
