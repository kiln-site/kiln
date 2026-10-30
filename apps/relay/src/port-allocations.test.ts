import { describe, expect, it } from "vite-plus/test"
import type { RelayInstancePortAllocation } from "@workspace/contracts"

import {
  discoverPortAllocations,
  portAllocationContainerLabels,
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
})
