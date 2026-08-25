import { describe, expect, it } from "vite-plus/test"
import {
  relayInstanceSchema,
  type RelayInstance,
  type RelaySnapshot,
} from "@workspace/contracts"

import { retainProvisioningInstances } from "./instance-mutation-snapshot.js"
import { RelaySnapshotHub } from "./snapshot-hub.js"

const instance = relayInstanceSchema.parse({
  connectAddress: "minecraft.test:25565",
  containerId: "container-one",
  desiredState: "running",
  directory: "a".repeat(40),
  game: "Minecraft",
  id: "a".repeat(40),
  implementation: "Paper",
  javaVersion: "21",
  name: "Test server",
  observedState: "running",
  service: "kiln-test-server",
  shortId: "aaaaaaaa",
  lifecycle: [
    { state: "started", time: "2026-08-08T12:00:00.000Z" },
    { state: "ready", time: "2026-08-08T12:00:15.000Z" },
  ],
  status: "Running",
  version: "1.21.8",
})

describe("instance mutation snapshots", () => {
  it("defaults state reasons for snapshots from older Relays", () => {
    expect(instance.stateReason).toBeNull()
  })

  it("retains a missing instance as provisioning while it is replaced", () => {
    const instances = retainProvisioningInstances([], [instance])

    expect(instances).toEqual([
      expect.objectContaining({
        containerId: null,
        id: instance.id,
        name: instance.name,
        lifecycle: [],
        observedState: "provisioning",
        resources: null,
        status: "Reprovisioning",
      }),
    ])
  })

  it("prefers the live replacement once it appears", () => {
    const replacement = { ...instance, containerId: "container-two" }
    const instances = retainProvisioningInstances([replacement], [instance])

    expect(instances).toEqual([replacement])
  })

  it("drops a sampled provisioning row as soon as failed retention is released", async () => {
    let retainedInstances: Array<RelayInstance> = [instance]
    const baseSnapshot = relaySnapshot([])
    const hub = new RelaySnapshotHub(
      () =>
        Promise.resolve({
          ...baseSnapshot,
          instances: retainProvisioningInstances([], retainedInstances),
        }),
      60_000
    )
    const samples: Array<Array<RelayInstance>> = []
    const unsubscribe = hub.subscribe((sample) =>
      samples.push(sample.snapshot.instances)
    )

    async function failMutation() {
      try {
        expect((await hub.read()).instances).toEqual([
          expect.objectContaining({
            id: instance.id,
            observedState: "provisioning",
          }),
        ])
        throw new Error("Rebuild failed")
      } finally {
        retainedInstances = []
        await hub.refresh()
      }
    }

    try {
      await expect(failMutation()).rejects.toThrow("Rebuild failed")
      expect(samples.at(-1)).toEqual([])
      await expect(hub.read()).resolves.toMatchObject({ instances: [] })
    } finally {
      unsubscribe()
      hub.close()
    }
  })
})

function relaySnapshot(instances: Array<RelayInstance>): RelaySnapshot {
  return {
    instances,
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
      startedAt: "2026-08-08T11:00:00.000Z",
      storage: { totalBytes: 100_000, usedBytes: 50_000 },
      uptimeSeconds: 3_600,
      version: "0.1.0",
    },
  }
}
