import { describe, expect, it } from "vite-plus/test"

import {
  relayBrowserMaxFrameBytes,
  relayInstanceResourceSnapshotSchema,
  relayInstanceResourcesSchema,
  relayInstanceSchema,
  relayResourceHistoryMaxSamples,
  relayResourceStreamEventSchema,
  relaySnapshotSchema,
} from "./index.js"

describe("Relay snapshot compatibility", () => {
  it("decodes SFTP publication from older Relays as unknown", () => {
    const snapshot = relaySnapshotSchema.parse({
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
        startedAt: "2026-08-08T11:00:00.000Z",
        storage: { totalBytes: 100_000, usedBytes: 50_000 },
        uptimeSeconds: 3_600,
        version: "0.1.0",
      },
      relay: {
        id: "r".repeat(43),
        name: "Test Relay",
        sftp: {
          developmentAuthentication: false,
          host: "relay.example.com",
          hostKeyFingerprint: "SHA256:relay-fingerprint",
          port: 2022,
        },
        tls: null,
      },
    })

    expect(snapshot.relay?.sftp.publication).toBe("unknown")
  })
})

describe("Relay resource history", () => {
  it("fits a full history in one browser frame and rejects a longer one", () => {
    const instance = relayInstanceSchema.parse({
      connectAddress: "history.test",
      containerId: null,
      desiredState: "running",
      directory: "a".repeat(40),
      game: "Minecraft",
      id: "a".repeat(40),
      implementation: "Paper",
      javaVersion: "21",
      managedByRelay: true,
      name: "history-test",
      observedState: "running",
      service: "kiln-history-test",
      shortId: "aaaaaaaa",
      startedAt: null,
      status: "running",
      version: "1.21.11",
    })
    const resource = relayInstanceResourcesSchema.parse({
      sampledAt: "2026-01-01T00:00:00.000Z",
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
        percent: 20,
        totalBytes: 25 * 1024 ** 3,
        usedBytes: 5 * 1024 ** 3,
      },
    })
    const history = Array.from(
      { length: relayResourceHistoryMaxSamples },
      (_, index) => ({
        ...resource,
        sampledAt: new Date(
          Date.parse(resource.sampledAt) + index * 2_000
        ).toISOString(),
      })
    )
    const event = { history, instance, sequence: 1, type: "resource" }

    expect(relayResourceStreamEventSchema.safeParse(event).success).toBe(true)
    expect(
      relayInstanceResourceSnapshotSchema.safeParse({ history, instance })
        .success
    ).toBe(true)
    expect(
      new TextEncoder().encode(JSON.stringify(event)).byteLength
    ).toBeLessThan(relayBrowserMaxFrameBytes)
    expect(
      relayResourceStreamEventSchema.safeParse({
        ...event,
        history: [...history, resource],
      }).success
    ).toBe(false)
  })
})
