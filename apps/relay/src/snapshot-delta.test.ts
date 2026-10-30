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
