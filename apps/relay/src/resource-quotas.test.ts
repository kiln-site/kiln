import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  relayDiskAllocationAvailableBytes,
} from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import { legacyDiskLimitAssignments } from "./resource-quotas.js"

const GIBIBYTE = 1024 ** 3

describe("Relay disk quotas", () => {
  it("caps legacy defaults at node capacity after the 10 GiB reserve", () => {
    const assignments = legacyDiskLimitAssignments(
      ["d", "b", "a", "c"].map((id) => ({
        configuredLimitBytes: null,
        id,
      })),
      28 * GIBIBYTE
    )

    expect(assignments.get("a")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
    expect(assignments.get("b")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
    expect(assignments.get("c")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
    expect(assignments.get("d")).toBe(3 * GIBIBYTE)
  })

  it("deducts configured quotas before assigning legacy defaults", () => {
    const assignments = legacyDiskLimitAssignments(
      [
        { configuredLimitBytes: 30 * GIBIBYTE, id: "configured" },
        { configuredLimitBytes: null, id: "legacy-a" },
        { configuredLimitBytes: null, id: "legacy-b" },
        { configuredLimitBytes: null, id: "legacy-c" },
      ],
      52 * GIBIBYTE
    )

    expect(assignments.get("legacy-a")).toBe(5 * GIBIBYTE)
    expect(assignments.get("legacy-b")).toBe(5 * GIBIBYTE)
    expect(assignments.get("legacy-c")).toBe(2 * GIBIBYTE)
  })

  it("treats a configured zero label as a missing legacy quota", () => {
    const assignments = legacyDiskLimitAssignments(
      [{ configuredLimitBytes: 0, id: "legacy" }],
      10 * GIBIBYTE
    )

    expect(assignments.get("legacy")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
  })

  it("uses the default instead of assigning below the positive quota floor", () => {
    const assignments = legacyDiskLimitAssignments(
      [{ configuredLimitBytes: null, id: "legacy" }],
      10 * GIBIBYTE + MINIMUM_INSTANCE_DISK_LIMIT_BYTES - 1
    )

    expect(assignments.get("legacy")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
  })

  it("grandfathers an unchanged quota on an oversubscribed node", () => {
    expect(
      relayDiskAllocationAvailableBytes(
        100 * GIBIBYTE,
        95 * GIBIBYTE,
        25 * GIBIBYTE
      )
    ).toBe(25 * GIBIBYTE)
  })
})
