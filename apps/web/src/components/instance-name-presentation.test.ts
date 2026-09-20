import { describe, expect, it } from "vite-plus/test"

import {
  instanceStatusPresentation,
  relayStatusPresentation,
} from "@/components/instance-name-presentation"

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

  it("does not present unresolved Relay reachability as offline", () => {
    expect(
      instanceStatusPresentation({
        enabled: true,
        id: "relay-a",
        kind: "relay",
        relayId: "relay-a",
        relayStatus: "checking",
      })
    ).toEqual({ label: "Checking", tone: "neutral" })

    expect(
      instanceStatusPresentation({
        enabled: true,
        id: "relay-a",
        kind: "relay",
        relayId: "relay-a",
        relayStatus: "unknown",
      })
    ).toEqual({ label: "Unknown", tone: "neutral" })
  })

  it.each([
    ["checking", "Checking", "neutral"],
    ["connected", "Online", "success"],
    ["paused", "Paused", "info"],
    ["unknown", "Unknown", "neutral"],
    ["unreachable", "Unreachable", "danger"],
  ] as const)(
    "keeps the %s Relay label shared across identity and status cells",
    (relayStatus, label, tone) => {
      expect(relayStatusPresentation({ enabled: true, relayStatus })).toEqual({
        label,
        tone,
      })
    }
  )
})
