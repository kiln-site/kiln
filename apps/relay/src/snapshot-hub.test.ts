import { setImmediate as yieldToEventLoop } from "node:timers/promises"

import type { RelaySnapshot } from "@workspace/contracts"
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test"

import { RelaySnapshotHub } from "./snapshot-hub.js"

beforeEach(() => {
  // Freeze time so the sample cache and resample timer only move on demand.
  vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
})

afterEach(() => {
  vi.useRealTimers()
})

describe("Relay snapshot hub", () => {
  it("coalesces concurrent samples and replays one shared result", async () => {
    let releaseLoad: () => void = () => undefined
    const loadReleased = new Promise<void>((resolve) => {
      releaseLoad = resolve
    })
    // Every load produces a distinct object, so identity shows sharing.
    const hub = new RelaySnapshotHub(async () => {
      await loadReleased
      return emptySnapshot()
    })

    const first = hub.read()
    const second = hub.read()
    releaseLoad()
    const shared = await first
    expect(await second).toBe(shared)

    const samples: Array<RelaySnapshot> = []
    const unsubscribe = hub.subscribe((sample) => samples.push(sample.snapshot))
    expect(samples).toEqual([shared])
    expect(await hub.read()).toBe(shared)

    unsubscribe()
    hub.close()
  })

  it("forces a fresh sample to readers and subscribers after a mutation", async () => {
    let current = emptySnapshot()
    const hub = new RelaySnapshotHub(() => Promise.resolve(current))
    const delivered: Array<RelaySnapshot> = []
    const unsubscribe = hub.subscribe((sample) =>
      delivered.push(sample.snapshot)
    )

    const initial = await hub.read()
    current = { ...emptySnapshot(), instances: [] }
    expect(await hub.read()).toBe(initial)

    expect(await hub.refresh()).toBe(current)
    expect(delivered.at(-1)).toBe(current)
    expect(await hub.read()).toBe(current)

    unsubscribe()
    hub.close()
  })

  it("refreshes after an in-flight sample fails", async () => {
    const recovered = emptySnapshot()
    let failSample: (cause: Error) => void = () => undefined
    let failed = false
    const hub = new RelaySnapshotHub(() => {
      if (failed) return Promise.resolve(recovered)
      failed = true
      return new Promise<RelaySnapshot>((_resolve, reject) => {
        failSample = reject
      })
    })

    const failedSample = hub.read()
    const refresh = hub.refresh()
    failSample(new Error("Sample failed"))

    await expect(failedSample).rejects.toThrow("Sample failed")
    await expect(refresh).resolves.toBe(recovered)
    hub.close()
  })

  it("isolates subscribers and interrupts in-flight delivery when closed", async () => {
    const snapshot = emptySnapshot()
    const delivered: Array<RelaySnapshot> = []
    const hub = new RelaySnapshotHub(() => Promise.resolve(snapshot))

    hub.subscribe(() => {
      throw new Error("subscriber failed")
    })
    hub.subscribe((sample) => delivered.push(sample.snapshot))
    expect(await hub.read()).toBe(snapshot)
    expect(delivered).toEqual([snapshot])
    hub.close()

    let finishLoad: (snapshot: RelaySnapshot) => void = () => undefined
    const closingHub = new RelaySnapshotHub(
      () =>
        new Promise<RelaySnapshot>((resolve) => {
          finishLoad = resolve
        })
    )
    const closingDelivered: Array<RelaySnapshot> = []
    closingHub.subscribe((sample) => closingDelivered.push(sample.snapshot))
    closingHub.close()
    finishLoad(emptySnapshot())
    for (let turn = 0; turn < 5; turn += 1) await yieldToEventLoop()

    expect(closingDelivered).toEqual([])
    expect(() => closingHub.subscribe(() => undefined)).toThrow()
    await expect(closingHub.read()).rejects.toThrow()
  })
})

function emptySnapshot(): RelaySnapshot {
  return {
    instances: [],
    node: {
      arch: "arm64",
      capabilities: [],
      canProvisionInstances: true,
      connectedAt: "2026-08-08T12:00:00.000Z",
      cpu: { cores: 8, loadPercent: 10 },
      docker: { available: true, version: "28.0.0" },
      id: "relay-test",
      memory: { totalBytes: 16_000, usedBytes: 8_000 },
      name: "Test Relay",
      platform: "linux",
      releaseName: null,
      startedAt: "2026-08-08T11:00:00.000Z",
      storage: { totalBytes: 100_000, usedBytes: 50_000 },
      uptimeSeconds: 3_600,
      version: "0.1.0",
    },
  }
}
