import { describe, expect, it } from "vite-plus/test"
import type { RelayInstance, RelaySnapshot } from "@workspace/contracts"

import {
  addRelayInstanceToSnapshot,
  relayInstanceRouteId,
  type RelayFleetSnapshot,
} from "@/lib/relay-fleet"
import { replaceRelaySnapshotInstance } from "@/lib/query-options"
import {
  findFirstCanonicalRelayInstance,
  findRelayInstance,
  relayInstanceRouteIdentifier,
  resolveCanonicalRelayInstance,
  resolveRelayInstance,
  selectInstanceContainerRunning,
  selectInstanceLifecycleStartedAt,
  selectInstanceRelayConnected,
  selectInstanceRuntime,
  selectInstanceStateReason,
  selectInstanceSettings,
  selectInstanceWorkspaceInstance,
  selectRouteInstances,
  selectServerListInstances,
  selectSidebarInstances,
} from "@/lib/relay-selectors"

const instance = {
  connectAddress: "minecraft.test:25565",
  game: "Minecraft",
  id: "a".repeat(40),
  implementation: "Fabric",
  javaVersion: "21",
  name: "Test server",
  observedState: "running",
  resources: {
    sampledAt: "2026-07-20T12:00:00.000Z",
    cpu: { percent: 12 },
    memory: { percent: 25, totalBytes: 100, usedBytes: 25 },
    storage: { percent: 40, totalBytes: 100, usedBytes: 40 },
  },
  service: "test-server",
  shortId: "aaaaaaaa",
  lifecycle: [
    { state: "started", time: "2026-07-20T11:00:00.000Z" },
    { state: "ready", time: "2026-07-20T11:00:15.000Z" },
  ],
  version: "1.21.11",
} as RelayInstance

function snapshotWithCpu(percent: number): RelayFleetSnapshot {
  return {
    instances: [
      {
        ...instance,
        relayId: "relay-one",
        relayName: "Relay one",
        relayStatus: "connected",
        routeId: "relay-one-aaaaaaaa",
        resources: {
          ...instance.resources!,
          sampledAt: `2026-07-20T12:00:0${percent}.000Z`,
          cpu: { capacityPercent: 400, percent },
        },
      },
    ],
    nodes: [
      {
        ...({} as RelaySnapshot["node"]),
        relayId: "relay-one",
        relayName: "Relay one",
        relayStatus: "connected",
      },
    ],
  }
}

describe("Relay render selectors", () => {
  it("builds route IDs from stable Relay and instance identities", () => {
    expect(relayInstanceRouteId("relay-one", "aaaaaaaa")).toBe(
      "relay-one-aaaaaaaa"
    )
  })

  it("makes a newly provisioned instance immediately routable", () => {
    const snapshot = snapshotWithCpu(1)
    const created = {
      ...instance,
      id: "b".repeat(40),
      name: "New server",
      shortId: "bbbbbbbb",
    }

    const updated = addRelayInstanceToSnapshot(snapshot, created, {
      id: "relay-one",
      name: "Relay one",
    })

    expect(updated?.instances[0]).toMatchObject({
      id: created.id,
      relayId: "relay-one",
      relayStatus: "connected",
      routeId: "relay-one-bbbbbbbb",
    })
    expect(
      resolveRelayInstance(updated?.instances ?? [], "relay-one-bbbbbbbb")
    ).toMatchObject({ status: "found", instance: { id: created.id } })
  })

  it("never replaces a canonical live instance with a stale create response", () => {
    const snapshot = snapshotWithCpu(1)
    const staleCreateResponse = {
      ...instance,
      name: "Stale provisioning response",
      provisioning: { attempt: 1, error: null, phase: "preparing" },
    } satisfies RelayInstance

    const updated = addRelayInstanceToSnapshot(snapshot, staleCreateResponse, {
      id: "relay-one",
      name: "Relay one",
    })

    expect(updated).toBe(snapshot)
    expect(updated?.instances[0]).toMatchObject({ name: "Test server" })
    expect(updated?.instances[0]).not.toHaveProperty("provisioning")
  })

  it("keeps sidebar and workspace data unchanged across resource samples", () => {
    const before = snapshotWithCpu(1)
    const after = snapshotWithCpu(2)

    expect(selectSidebarInstances(after)).toEqual(
      selectSidebarInstances(before)
    )
    expect(selectServerListInstances(after)).toEqual(
      selectServerListInstances(before)
    )
    expect(selectInstanceWorkspaceInstance(instance.id)(after)).toEqual(
      selectInstanceWorkspaceInstance(instance.id)(before)
    )
    expect(selectInstanceSettings(instance.id)(after)).toEqual(
      selectInstanceSettings(instance.id)(before)
    )
  })

  it("continues publishing each resource sample to the runtime subscriber", () => {
    const before = selectInstanceRuntime(instance.id)(snapshotWithCpu(1))
    const after = selectInstanceRuntime(instance.id)(snapshotWithCpu(2))

    expect(before?.resources?.cpu.percent).toBe(1)
    expect(after?.resources?.cpu.percent).toBe(2)
    expect(after?.resources?.sampledAt).not.toBe(before?.resources?.sampledAt)
  })

  it("selects the current lifecycle start without subscribing to resources", () => {
    const before = snapshotWithCpu(1)
    const after = snapshotWithCpu(2)

    expect(selectInstanceLifecycleStartedAt(instance.id)(before)).toBe(
      "2026-07-20T11:00:00.000Z"
    )
    expect(selectInstanceLifecycleStartedAt(instance.id)(after)).toBe(
      selectInstanceLifecycleStartedAt(instance.id)(before)
    )
  })

  it("treats a starting container as available for console input", () => {
    const snapshot = snapshotWithCpu(1)
    snapshot.instances = snapshot.instances.map((item) => ({
      ...item,
      observedState: "starting",
    }))

    expect(
      selectInstanceContainerRunning(instance.id, "relay-one")(snapshot)
    ).toBe(true)
  })

  it("keeps sidebar identity stable while route availability changes", () => {
    const connected = snapshotWithCpu(1)
    const unreachable: RelayFleetSnapshot = {
      ...connected,
      instances: connected.instances.map((item) => ({
        ...item,
        relayStatus: "unreachable",
      })),
    }

    expect(selectSidebarInstances(unreachable)).toEqual(
      selectSidebarInstances(connected)
    )
    expect(selectRouteInstances(unreachable)).not.toEqual(
      selectRouteInstances(connected)
    )
  })

  it("updates only the matching Relay when local instance IDs collide", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const second = {
      ...first,
      relayId: "relay-two",
      relayName: "Relay two",
      routeId: "relay-two-aaaaaaaa",
    }
    const snapshot = snapshotWithCpu(1)
    snapshot.instances.push(second)

    const updated = replaceRelaySnapshotInstance(snapshot, {
      ...first,
      name: "Renamed on Relay one",
    })

    expect(updated?.instances.map((item) => item.name)).toEqual([
      "Renamed on Relay one",
      "Test server",
    ])
  })

  it("preserves a managed address across Relay stream updates", () => {
    const current = snapshotWithCpu(1)
    const first = current.instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    current.instances[0] = {
      ...first,
      connectAddress: "ember-falls.kiln.site",
      publicHost: "relay.example.com",
      publicPort: 32_001,
    }

    const updated = replaceRelaySnapshotInstance(current, {
      ...first,
      connectAddress: "relay.example.com:32001",
      publicHost: "relay.example.com",
      publicPort: 32_001,
    })

    expect(updated?.instances[0]?.connectAddress).toBe("ember-falls.kiln.site")
  })

  it("clears optional Relay fields while retaining fleet metadata", () => {
    const current = snapshotWithCpu(1)
    const first = current.instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    current.instances[0] = {
      ...first,
      provisioning: {
        attempt: 1,
        error: null,
        phase: "finalizing",
      },
    }

    const updated = replaceRelaySnapshotInstance(current, first)

    expect(updated?.instances[0]).not.toHaveProperty("provisioning")
    expect(updated?.instances[0]).toMatchObject({
      relayName: "Relay one",
      relayStatus: "connected",
      routeId: "relay-one-aaaaaaaa",
    })
  })

  it("selects connectivity from the instance's Relay when IDs collide", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const snapshot = snapshotWithCpu(1)
    snapshot.instances.push({
      ...first,
      relayId: "relay-two",
      relayName: "Relay two",
      relayStatus: "unreachable",
      routeId: "relay-two-aaaaaaaa",
    })

    expect(selectInstanceRelayConnected(first.id, "relay-one")(snapshot)).toBe(
      true
    )
    expect(selectInstanceRelayConnected(first.id, "relay-two")(snapshot)).toBe(
      false
    )
  })

  it("does not select the first server when accessible short IDs collide", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const snapshot = snapshotWithCpu(1)
    snapshot.instances.push({
      ...first,
      id: "b".repeat(40),
      relayId: "relay-two",
      relayName: "Relay two",
      routeId: "relay-two-aaaaaaaa",
    })

    expect(findRelayInstance(snapshot.instances, first.shortId)).toBeUndefined()
    expect(resolveRelayInstance(snapshot.instances, first.shortId)).toEqual({
      status: "ambiguous",
    })
  })

  it("resolves exactly one accessible short-ID match without exposing misses", () => {
    const snapshot = snapshotWithCpu(1)
    const first = snapshot.instances[0]
    if (!first) throw new Error("Expected Relay fixture")

    expect(resolveRelayInstance(snapshot.instances, first.shortId)).toEqual({
      status: "found",
      instance: first,
    })
    expect(resolveRelayInstance(snapshot.instances, "deadbeef")).toEqual({
      status: "not-found",
    })
  })

  it("keeps a unique legacy Relay-qualified alias resolvable", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const second = {
      ...first,
      id: "b".repeat(40),
      relayId: "relay-two",
      relayName: "Relay two",
      routeId: "relay-two-aaaaaaaa",
    }
    const snapshot = snapshotWithCpu(1)
    snapshot.instances[0] = {
      ...first,
      routeId: "relay-one-aaaaaaaa",
    }
    snapshot.instances.push(second)

    expect(
      resolveRelayInstance(snapshot.instances, "relay-two-aaaaaaaa")
    ).toEqual({
      status: "found",
      instance: second,
    })
  })

  it("uses short IDs when unique and Relay-qualified routes on collision", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const snapshot = snapshotWithCpu(1)

    expect(relayInstanceRouteIdentifier(snapshot.instances, first)).toBe(
      first.shortId
    )
    expect(
      resolveCanonicalRelayInstance(snapshot.instances, first.routeId)
    ).toEqual({
      status: "found",
      instance: first,
    })

    const collision = {
      ...first,
      id: "b".repeat(40),
      relayId: "relay-two",
      relayName: "Relay two",
      routeId: "relay-two-aaaaaaaa",
    }
    snapshot.instances.push(collision)

    expect(relayInstanceRouteIdentifier(snapshot.instances, first)).toBe(
      first.routeId
    )
    expect(relayInstanceRouteIdentifier(snapshot.instances, collision)).toBe(
      collision.routeId
    )
    expect(
      resolveCanonicalRelayInstance(snapshot.instances, first.routeId)
    ).toEqual({
      status: "found",
      instance: first,
    })
    expect(
      resolveCanonicalRelayInstance(snapshot.instances, collision.routeId)
    ).toEqual({
      status: "found",
      instance: collision,
    })
    expect(resolveCanonicalRelayInstance(snapshot.instances, first.id)).toEqual(
      {
        status: "found",
        instance: first,
      }
    )
    expect(
      resolveCanonicalRelayInstance(snapshot.instances, first.shortId)
    ).toEqual({
      status: "ambiguous",
    })
  })

  it("chooses a colliding server when its Relay-qualified route is unique", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const collision = {
      ...first,
      id: "b".repeat(40),
      relayId: "relay-two",
      relayName: "Relay two",
      routeId: "relay-two-aaaaaaaa",
    }
    expect(findFirstCanonicalRelayInstance([first, collision])).toEqual(first)
  })

  it("rejects collisions that also share a Relay-qualified route", () => {
    const first = snapshotWithCpu(1).instances[0]
    if (!first) throw new Error("Expected Relay fixture")
    const collision = {
      ...first,
      id: "b".repeat(40),
      relayId: "relay-two",
      relayName: "Relay two",
    }

    expect(
      relayInstanceRouteIdentifier([first, collision], first)
    ).toBeUndefined()
    expect(findFirstCanonicalRelayInstance([first, collision])).toBeUndefined()
  })

  it("isolates lifecycle reasons from stable workspace metadata", () => {
    const before = snapshotWithCpu(1)
    const after = snapshotWithCpu(1)
    const current = after.instances[0]
    if (!current) throw new Error("Expected an instance fixture")
    after.instances[0] = {
      ...current,
      stateReason: { code: "waiting_for_readiness" },
    }

    expect(selectInstanceWorkspaceInstance(instance.id)(after)).toEqual(
      selectInstanceWorkspaceInstance(instance.id)(before)
    )
    expect(selectInstanceStateReason(instance.id)(before)).toBeNull()
    expect(selectInstanceStateReason(instance.id)(after)).toEqual({
      code: "waiting_for_readiness",
    })
  })
})
