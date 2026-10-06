import { describe, expect, it } from "vite-plus/test"
import type { RelayInstancePortAllocation } from "@workspace/contracts"

import {
  discoverPortAllocations,
  dockerPortBindingsForAllocations,
  portAllocationContainerLabels,
  portLabelsRequireRestart,
} from "./port-allocations.js"

describe("instance port allocations", () => {
  const allocations = [
    {
      externalPort: 30_000,
      id: "primary",
      internalPort: 25_565,
      kind: "primary",
      name: "Game port",
      protocol: "tcp",
    },
    {
      externalPort: 30_001,
      id: "a1b2c3d4",
      internalPort: 24_454,
      kind: "custom",
      name: "Voice chat",
      protocol: "udp",
    },
  ] satisfies ReadonlyArray<RelayInstancePortAllocation>

  it("writes one recoverable label per route", () => {
    expect(portAllocationContainerLabels(allocations)).toEqual({
      "kiln.brick.primary-port": "25565/tcp",
      "kiln.instance.custom-routes.a1b2c3d4":
        '{"internal":24454,"name":"Voice chat","protocol":"udp","public":30001}',
    })
  })

  it("uses live Docker bindings when recovering routes from labels", () => {
    expect(
      discoverPortAllocations({
        bindings: {
          "24454/udp": [{ HostPort: "32001" }],
          "25565/tcp": [{ HostPort: "32000" }],
        },
        labels: portAllocationContainerLabels(allocations),
      })
    ).toEqual([
      {
        externalPort: 32_000,
        id: "primary",
        internalPort: 25_565,
        kind: "primary",
        name: "Default Server",
        protocol: "tcp",
      },
      {
        externalPort: 32_001,
        id: "a1b2c3d4",
        internalPort: 24_454,
        kind: "custom",
        name: "Voice chat",
        protocol: "udp",
      },
    ])
  })

  it("recovers a custom route's labelled public port without a live binding", () => {
    expect(
      discoverPortAllocations({
        bindings: {
          "25565/tcp": [{ HostPort: "32000" }],
        },
        labels: portAllocationContainerLabels(allocations),
      })
    ).toEqual([
      {
        externalPort: 32_000,
        id: "primary",
        internalPort: 25_565,
        kind: "primary",
        name: "Default Server",
        protocol: "tcp",
      },
      {
        externalPort: 30_001,
        id: "a1b2c3d4",
        internalPort: 24_454,
        kind: "custom",
        name: "Voice chat",
        protocol: "udp",
      },
    ])
  })

  it("encodes a TCP and UDP allocation as a bare primary port", () => {
    const both = [
      {
        externalPort: 30_000,
        id: "primary",
        internalPort: 19_132,
        kind: "primary",
        name: "Game port",
        protocol: "both",
      },
    ] satisfies ReadonlyArray<RelayInstancePortAllocation>

    expect(portAllocationContainerLabels(both)).toEqual({
      "kiln.brick.primary-port": "19132",
    })
    expect(dockerPortBindingsForAllocations(both)).toEqual({
      "19132/tcp": [{ HostIp: "", HostPort: "30000" }],
      "19132/udp": [{ HostIp: "", HostPort: "30000" }],
    })
    expect(
      discoverPortAllocations({
        bindings: {
          "19132/tcp": [{ HostPort: "30000" }],
          "19132/udp": [{ HostPort: "30000" }],
        },
        labels: portAllocationContainerLabels(both),
      })
    ).toEqual([
      {
        externalPort: 30_000,
        id: "primary",
        internalPort: 19_132,
        kind: "primary",
        name: "Default Server",
        protocol: "both",
      },
    ])
  })

  it.each(["tcp", "udp"] as const)(
    "recovers a main-era bare primary port using its %s companion label",
    (protocol) => {
      expect(
        discoverPortAllocations({
          bindings: {
            [`25565/${protocol}`]: [{ HostPort: "32000" }],
          },
          labels: {
            "kiln.brick.primary-port": "25565",
            "kiln.brick.primary-port-protocol": protocol,
          },
        })
      ).toEqual([
        {
          externalPort: 32_000,
          id: "primary",
          internalPort: 25_565,
          kind: "primary",
          name: "Default Server",
          protocol,
        },
      ])
    }
  )

  it("prefers an explicit primary-port suffix over the companion label", () => {
    expect(
      discoverPortAllocations({
        bindings: {
          "25565/tcp": [{ HostPort: "32000" }],
        },
        labels: {
          "kiln.brick.primary-port": "25565/tcp",
          "kiln.brick.primary-port-protocol": "udp",
        },
      })
    ).toEqual([
      {
        externalPort: 32_000,
        id: "primary",
        internalPort: 25_565,
        kind: "primary",
        name: "Default Server",
        protocol: "tcp",
      },
    ])
  })

  it("reads the aggregate format once so the next boot can replace it", () => {
    expect(
      discoverPortAllocations({
        bindings: {
          "24454/udp": [{ HostPort: "32001" }],
          "25565/tcp": [{ HostPort: "32000" }],
        },
        labels: {
          "kiln.brick.primary-port": "25565",
          "kiln.brick.primary-port-protocol": "tcp",
          "kiln.instance.ports":
            '[{"id":"primary","kind":"primary","internalPort":25565,"name":"game","protocol":"tcp"},{"id":"a1b2c3d4","kind":"custom","internalPort":24454,"name":"Voice chat","protocol":"udp"}]',
        },
      })
    ).toEqual([
      {
        externalPort: 32_000,
        id: "primary",
        internalPort: 25_565,
        kind: "primary",
        name: "game",
        protocol: "tcp",
      },
      {
        externalPort: 32_001,
        id: "a1b2c3d4",
        internalPort: 24_454,
        kind: "custom",
        name: "Voice chat",
        protocol: "udp",
      },
    ])
  })

  it("requires a restart for missing, changed, or stale managed labels", () => {
    const desired = portAllocationContainerLabels(allocations)
    expect(portLabelsRequireRestart(desired, desired)).toBe(false)
    expect(portLabelsRequireRestart({}, desired)).toBe(true)
    expect(
      portLabelsRequireRestart(
        {
          "kiln.brick.primary-port": "25565",
          "kiln.brick.primary-port-protocol": "tcp",
        },
        {
          "kiln.brick.primary-port": "25565/tcp",
        }
      )
    ).toBe(true)
    expect(
      portLabelsRequireRestart(
        {
          ...desired,
          "kiln.instance.custom-routes.deadbeef":
            '{"internal":19132,"name":"Stale","protocol":"udp","public":30002}',
        },
        desired
      )
    ).toBe(true)
  })

  it("does not infer allocations without managed metadata", () => {
    expect(
      discoverPortAllocations({
        bindings: {
          "19132/udp": [{ HostPort: "30132" }],
          "25565/tcp": [{ HostPort: "30565" }],
        },
        labels: {},
      })
    ).toEqual([])
  })

  it("ignores malformed JSON labels without throwing", () => {
    expect(
      discoverPortAllocations({
        bindings: {},
        labels: {
          "kiln.instance.custom-routes.deadbeef": "{not-json",
          "kiln.instance.ports": "[not-json",
        },
      })
    ).toEqual([])
  })
})
