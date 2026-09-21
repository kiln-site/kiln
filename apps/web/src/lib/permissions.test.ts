import { describe, expect, it } from "vite-plus/test"

import {
  instancePortsWritePermission,
  platformRoleHasPermission,
} from "@/lib/permissions"

describe("platform appearance permissions", () => {
  it("reserves appearance defaults for platform administrators", () => {
    expect(
      platformRoleHasPermission("admin", "platform.appearance.manage-default")
    ).toBe(true)
    expect(
      platformRoleHasPermission("user", "platform.appearance.manage-default")
    ).toBe(false)
  })
})

describe("Brick source permissions", () => {
  it("allows platform administrators and Relay creators to add sources", () => {
    for (const permission of [
      "platform.bricks.add-catalog",
      "platform.bricks.add-custom",
    ] as const) {
      expect(platformRoleHasPermission("admin", permission)).toBe(true)
      expect(platformRoleHasPermission("relay_creator", permission)).toBe(true)
      expect(platformRoleHasPermission("user", permission)).toBe(false)
    }
  })
})

describe("public port permissions", () => {
  it("reserves public port range overrides for platform administrators", () => {
    expect(
      platformRoleHasPermission(
        "admin",
        "platform.network.override-public-port-range"
      )
    ).toBe(true)
    expect(
      platformRoleHasPermission(
        "user",
        "platform.network.override-public-port-range"
      )
    ).toBe(false)
  })

  it("protects replacements without blocking new allocations", () => {
    expect(
      instancePortsWritePermission([{ externalPort: 32_124, id: "primary" }])
    ).toBe("instance.network.public-port.write")
    expect(
      instancePortsWritePermission([
        { externalPort: 32_124, id: "custom-allocation" },
      ])
    ).toBe("instance.network.public-port.write")
    expect(instancePortsWritePermission([{ externalPort: 32_124 }])).toBe(
      "instance.network.write"
    )
    expect(instancePortsWritePermission([{ id: "primary" }])).toBe(
      "instance.network.write"
    )
  })
})

describe("backup permissions", () => {
  it("reserves platform destinations and caps for platform administrators", () => {
    expect(
      platformRoleHasPermission("admin", "platform.backups.manage-storage")
    ).toBe(true)
    expect(
      platformRoleHasPermission("admin", "platform.backups.manage-limits")
    ).toBe(true)
    expect(
      platformRoleHasPermission("user", "platform.backups.manage-storage")
    ).toBe(false)
    expect(
      platformRoleHasPermission("user", "platform.backups.manage-limits")
    ).toBe(false)
  })
})
