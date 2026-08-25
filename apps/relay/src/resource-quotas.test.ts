import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
  relayCreateInstanceSchema,
  relayDiskAllocationAvailableBytes,
  relayInstanceNameSchema,
  relayInstanceLimitsSchema,
  relayUpdateInstanceStartupSchema,
} from "@workspace/contracts"
import { describe, expect, it } from "vite-plus/test"

import {
  diskQuotaExceeded,
  initialDiskUsageCacheEntry,
  legacyDiskLimitAssignments,
} from "./docker.js"

const GIBIBYTE = 1024 ** 3

describe("Relay disk quotas", () => {
  it("limits instance names to 32 characters", () => {
    expect(relayInstanceNameSchema.safeParse("a".repeat(32)).success).toBe(
      true
    )
    expect(relayInstanceNameSchema.safeParse("a".repeat(33)).success).toBe(
      false
    )
  })

  it("caps legacy defaults at node capacity after the 10 GiB reserve", () => {
    const assignments = legacyDiskLimitAssignments(
      ["d", "b", "a", "c"].map((id) => ({
        configuredLimitBytes: null,
        id,
      })),
      100 * GIBIBYTE
    )

    expect(assignments.get("a")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
    expect(assignments.get("b")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
    expect(assignments.get("c")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
    expect(assignments.get("d")).toBe(15 * GIBIBYTE)
  })

  it("deducts configured quotas before assigning legacy defaults", () => {
    const assignments = legacyDiskLimitAssignments(
      [
        { configuredLimitBytes: 30 * GIBIBYTE, id: "configured" },
        { configuredLimitBytes: null, id: "legacy-a" },
        { configuredLimitBytes: null, id: "legacy-b" },
        { configuredLimitBytes: null, id: "legacy-c" },
      ],
      100 * GIBIBYTE
    )

    expect(assignments.get("legacy-a")).toBe(25 * GIBIBYTE)
    expect(assignments.get("legacy-b")).toBe(25 * GIBIBYTE)
    expect(assignments.get("legacy-c")).toBe(10 * GIBIBYTE)
  })

  it("defaults new requests to 25 GiB and rejects an explicit zero quota", () => {
    const input = {
      recipe: "https://example.com/brick.yml",
      variables: {},
    }

    expect(relayCreateInstanceSchema.parse(input).diskLimitBytes).toBe(
      DEFAULT_INSTANCE_DISK_LIMIT_BYTES
    )
    expect(
      relayCreateInstanceSchema.safeParse({ ...input, diskLimitBytes: 0 })
        .success
    ).toBe(false)
    expect(
      relayCreateInstanceSchema.safeParse({
        ...input,
        diskLimitBytes: MINIMUM_INSTANCE_DISK_LIMIT_BYTES,
      }).success
    ).toBe(true)
  })

  it("does not apply the creation default to startup patches", () => {
    const parsed = relayUpdateInstanceStartupSchema.parse({
      variables: { memory: "4G" },
    })

    expect(parsed.diskLimitBytes).toBeUndefined()
    expect(parsed.reinstall).toBeUndefined()
  })

  it("accepts a Brick reinstall startup patch without client variables", () => {
    const parsed = relayUpdateInstanceStartupSchema.parse({
      reinstall: true,
    })

    expect(parsed.reinstall).toBe(true)
    expect(parsed.variables).toBeUndefined()
  })

  it("rejects a startup patch that omits both reinstall and variables", () => {
    expect(relayUpdateInstanceStartupSchema.safeParse({}).success).toBe(false)
  })

  it("treats a configured zero label as a missing legacy quota", () => {
    const assignments = legacyDiskLimitAssignments(
      [{ configuredLimitBytes: 0, id: "legacy" }],
      10 * GIBIBYTE
    )

    expect(assignments.get("legacy")).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
    expect(
      relayInstanceLimitsSchema.parse({
        diskBytes: 0,
        memoryBytes: 0,
      }).diskBytes
    ).toBe(DEFAULT_INSTANCE_DISK_LIMIT_BYTES)
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

  it("uses the current quota after a queued scan finishes", () => {
    const usedBytes = 20 * GIBIBYTE

    expect(diskQuotaExceeded(usedBytes, 15 * GIBIBYTE, true)).toBe(true)
    expect(diskQuotaExceeded(usedBytes, 25 * GIBIBYTE, true)).toBe(false)
  })

  it("keeps disk usage unknown until the first successful scan", () => {
    expect(initialDiskUsageCacheEntry().usedBytes).toBeNull()
  })
})
