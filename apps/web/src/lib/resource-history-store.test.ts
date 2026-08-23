import { relayInstanceResourcesSchema } from "@workspace/contracts"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

import {
  RESOURCE_HISTORY_WINDOW_MS,
  resourceHistoryStore,
} from "./resource-history-store"

afterEach(() => vi.restoreAllMocks())

describe("Resource history store", () => {
  it("records CPU, memory, network, and node disk while folder usage is unknown", () => {
    const resources = resourcesAt(new Date().toISOString())
    const store = resourceHistoryStore("pending-disk", "instance")

    store.record([], resources)

    expect(store.getSnapshot()).toEqual([
      {
        cpu: 125.5,
        memory: 50,
        network: 579,
        networkReceived: 456,
        networkSent: 123,
        storage: null,
        storageNode: 40,
        timestamp: Date.parse(resources.sampledAt),
      },
    ])
  })

  it("advances the sample sequence with irregular samples and a full window", () => {
    const store = resourceHistoryStore("network-phase", "instance")
    const now = Date.parse("2099-08-23T12:00:00.000Z")
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now)
    const oldest = resourcesAt(
      new Date(now - RESOURCE_HISTORY_WINDOW_MS).toISOString()
    )
    const first = resourcesAt(new Date(now).toISOString())
    const second = resourcesAt(new Date(now + 4_000).toISOString())
    const third = resourcesAt(new Date(now + 8_000).toISOString())

    store.record([oldest], first)
    expect(store.getLatestSampleSequence()).toBe(0)
    expect(store.getSnapshot()).toHaveLength(2)

    store.record([oldest], first)
    expect(store.getLatestSampleSequence()).toBe(0)

    nowSpy.mockReturnValue(now + 4_000)
    store.record([], second)
    expect(store.getLatestSampleSequence()).toBe(1)
    expect(store.getSnapshot()).toHaveLength(2)

    nowSpy.mockReturnValue(now + 8_000)
    store.record([], third)
    expect(store.getLatestSampleSequence()).toBe(2)
  })
})

function resourcesAt(sampledAt: string) {
  return relayInstanceResourcesSchema.parse({
    sampledAt,
    cpu: { capacityPercent: 800, percent: 125.5 },
    memory: {
      percent: 50,
      totalBytes: 2 * 1024 ** 3,
      usedBytes: 1024 ** 3,
    },
    network: {
      receivedBytes: 12_345,
      receivedBytesPerSecond: 456,
      sentBytes: 6_789,
      sentBytesPerSecond: 123,
    },
    storage: {
      nodePercent: 40,
      nodeTotalBytes: 590 * 1024 ** 3,
      nodeUsedBytes: 236 * 1024 ** 3,
      percent: null,
      totalBytes: 25 * 1024 ** 3,
      usedBytes: null,
    },
  })
}
