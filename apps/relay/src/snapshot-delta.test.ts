import { describe, expect, it } from "vite-plus/test"

import type { RelaySnapshot } from "@workspace/contracts"

import { relaySnapshotControlDelta } from "@workspace/contracts"

import {
  applyRelaySnapshotDelta,
  createRelaySnapshotDelta,
} from "./snapshot-delta.js"

const instanceA = {
  id: "a".repeat(40),
  shortId: "a".repeat(8),
  name: "Alpha",
} as RelaySnapshot["instances"][number]
const instanceB = {
  id: "b".repeat(40),
  shortId: "b".repeat(8),
  name: "Beta",
} as RelaySnapshot["instances"][number]
const node = {
  id: "node-a",
  name: "relay-a",
} as unknown as RelaySnapshot["node"]
const relay = {
  browserOrigin: "https://relay.example.com",
  id: "relay-a",
  name: "Relay A",
  proxyMode: "none",
  sftp: {},
  tls: null,
} as unknown as NonNullable<RelaySnapshot["relay"]>

function relayMemory(rssBytes: number, fileBytes: number) {
  return {
    container: {
      activeFileBytes: fileBytes / 2,
      anonBytes: rssBytes,
      fileBytes,
      inactiveFileBytes: fileBytes / 2,
      kernelBytes: 1_024,
      limitBytes: null,
      usedBytes: rssBytes + fileBytes,
    },
    process: {
      arrayBuffersBytes: 1_024,
      externalBytes: 2_048,
      heapTotalBytes: rssBytes / 2,
      heapUsedBytes: rssBytes / 4,
      rssBytes,
    },
  }
}

function snapshot(
  instances: RelaySnapshot["instances"],
  nextNode = node,
  nextRelay?: RelaySnapshot["relay"]
): RelaySnapshot {
  return {
    instances,
    node: nextNode,
    ...(nextRelay ? { relay: nextRelay } : {}),
  }
}

describe("Relay snapshot deltas", () => {
  it("does not emit unchanged snapshots", () => {
    expect(
      createRelaySnapshotDelta(snapshot([instanceA]), snapshot([instanceA]))
    ).toBeNull()
  })

  it("keeps resource samples off the fleet-wide control stream", () => {
    const previous = snapshot(
      [
        {
          ...instanceA,
          resources: { cpuPercent: 1 },
        } as unknown as typeof instanceA,
      ],
      {
        ...node,
        cpu: { cores: 8, loadPercent: 10 },
        memory: { totalBytes: 100, usedBytes: 25 },
        relayMemory: relayMemory(4_096, 8_192),
        storage: { totalBytes: 200, usedBytes: 50 },
        uptimeSeconds: 10,
      }
    )
    const next = snapshot(
      [
        {
          ...instanceA,
          resources: { cpuPercent: 80 },
        } as unknown as typeof instanceA,
      ],
      {
        ...node,
        cpu: { cores: 8, loadPercent: 90 },
        memory: { totalBytes: 100, usedBytes: 75 },
        relayMemory: relayMemory(6_144, 16_384),
        storage: { totalBytes: 200, usedBytes: 80 },
        uptimeSeconds: 12,
      }
    )

    expect(createRelaySnapshotDelta(previous, next)).toBeNull()
  })

  it("keeps node resources current for Hearths that opt in without waking browsers", () => {
    const previous = snapshot([instanceA], {
      ...node,
      memory: { totalBytes: 100, usedBytes: 25 },
      relayMemory: relayMemory(4_096, 8_192),
    })
    const next = snapshot([instanceA], {
      ...node,
      memory: { totalBytes: 100, usedBytes: 75 },
      relayMemory: relayMemory(6_144, 16_384),
    })
    const delta = createRelaySnapshotDelta(previous, next, {
      nodeResources: true,
    })

    expect(delta).not.toBeNull()
    expect(applyRelaySnapshotDelta(previous, delta!)).toEqual(next)
    expect(relaySnapshotControlDelta(previous, delta!)).toBeNull()

    const renamed = snapshot([instanceA], { ...next.node, name: "relay-b" })
    const renameDelta = createRelaySnapshotDelta(previous, renamed, {
      nodeResources: true,
    })
    expect(relaySnapshotControlDelta(previous, renameDelta!)?.node).toEqual(
      renamed.node
    )
  })

  it("contains only changed, added, and deleted instances", () => {
    const updatedA = { ...instanceA, name: "Renamed" }
    const delta = createRelaySnapshotDelta(
      snapshot([instanceA, instanceB]),
      snapshot([updatedA, { ...instanceB, id: "c".repeat(40) }])
    )

    expect(delta).toMatchObject({
      deletedInstanceIds: [instanceB.id],
      instances: [updatedA, { ...instanceB, id: "c".repeat(40) }],
    })
  })

  it("reconstructs the next snapshot", () => {
    const previous = snapshot([instanceA, instanceB])
    const next = snapshot([{ ...instanceA, name: "Renamed" }], {
      ...node,
      name: "relay-b",
    })
    const delta = createRelaySnapshotDelta(previous, next)

    expect(delta).not.toBeNull()
    expect(applyRelaySnapshotDelta(previous, delta!)).toEqual(next)
  })

  it("synchronizes browser routing metadata", () => {
    const previous = snapshot([instanceA], node, relay)
    const next = snapshot([instanceA], node, {
      ...relay,
      browserOrigin: "https://hearth.example.com",
      proxyMode: "hearth",
    })
    const delta = createRelaySnapshotDelta(previous, next)

    expect(delta?.relay).toMatchObject({
      browserOrigin: "https://hearth.example.com",
      proxyMode: "hearth",
    })
    expect(applyRelaySnapshotDelta(previous, delta!)).toEqual(next)
  })
})
