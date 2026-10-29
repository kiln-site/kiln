import { afterEach, expect, it, vi } from "vite-plus/test"

import { holdingRelayVolumeReferences } from "@/lib/volume-reference-hold.server"
import { volumeReferencesHeld } from "@/lib/volume-reference-gate"

// The Relays are the only boundary: each holds or is unreachable.
const relays = vi.hoisted(() => ({
  held: [] as Array<string>,
  unreachable: new Set<string>(),
}))
vi.mock("@/lib/relay-registry", () => ({
  listPersistedRelays: async () => [
    { enabled: true, id: "relay-a", name: "Alpha" },
    { enabled: true, id: "relay-b", name: "Beta" },
  ],
}))
vi.mock("@/lib/relay-connection", () => ({
  reconnectRelayConnections: () => undefined,
  relayConnectionFeatures: () => new Set<string>(),
  relayRpc: async (relay: { id: string }) => {
    if (relays.unreachable.has(relay.id)) throw new Error("Relay is offline")
    relays.held.push(relay.id)
    return { held: true }
  },
}))

afterEach(() => {
  relays.held = []
  relays.unreachable.clear()
})

it("replaces Hearth's database only after every Relay holds its configurations, sending none meanwhile", async () => {
  let heldWhileReplacing: Array<string> = []
  let gated = false
  await holdingRelayVolumeReferences(async () => {
    heldWhileReplacing = [...relays.held]
    gated = volumeReferencesHeld() !== null
  })

  expect(heldWhileReplacing.sort()).toEqual(["relay-a", "relay-b"])
  expect(gated).toBe(true)
  expect(volumeReferencesHeld()).toBeNull()
})

it("refuses to replace Hearth's database when a Relay can't be told", async () => {
  relays.unreachable.add("relay-b")
  const replace = vi.fn(async () => undefined)

  await expect(holdingRelayVolumeReferences(replace)).rejects.toThrow(
    "Nothing was imported: Beta"
  )
  expect(replace).not.toHaveBeenCalled()
  expect(volumeReferencesHeld()).toBeNull()
})
