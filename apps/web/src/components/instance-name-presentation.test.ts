import { describe, expect, it } from "vite-plus/test"

import { instanceStatusPresentation } from "@/components/instance-name-presentation"

describe("instanceStatusPresentation", () => {
  it.each([
    ["provisioning", "Provisioning", "warning"],
    ["stopping", "Stopping", "warning"],
  ] as const)(
    "keeps database %s status consistent across identity and status cells",
    (observedState, label, tone) => {
      expect(
        instanceStatusPresentation({
          id: "database-a",
          inventoryStatus: "available",
          kind: "database",
          observedState,
          relayId: "relay-a",
        })
      ).toEqual({ label, tone })
    }
  )

  it("prefers canonical Relay reachability over historical fields", () => {
    expect(
      instanceStatusPresentation({
        connected: false,
        enabled: true,
        id: "relay-a",
        kind: "relay",
        lastError: "Previous connection failed",
        relayId: "relay-a",
        relayStatus: "connected",
      })
    ).toEqual({ label: "Online", tone: "success" })

    expect(
      instanceStatusPresentation({
        connected: true,
        enabled: true,
        id: "relay-a",
        kind: "relay",
        lastError: null,
        relayId: "relay-a",
        relayStatus: "unreachable",
      })
    ).toEqual({ label: "Unreachable", tone: "danger" })
  })
})
