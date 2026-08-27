import { describe, expect, it } from "vite-plus/test"

import type { RelaySnapshot } from "@workspace/contracts"

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

function snapshot(
  instances: RelaySnapshot["instances"],
  nextNode = node
): RelaySnapshot {
  return { instances, node: nextNode }
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
        storage: { totalBytes: 200, usedBytes: 80 },
        uptimeSeconds: 12,
      }
    )

    expect(createRelaySnapshotDelta(previous, next)).toBeNull()
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
})
