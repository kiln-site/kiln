import { describe, expect, it } from "vite-plus/test"

import { instancePortsWritePermission } from "@/lib/permissions"

describe("public port permissions", () => {
  it("protects replacements without blocking new allocations", () => {
    expect(
      instancePortsWritePermission([{ externalPort: 32_124, id: "primary" }])
    ).toBe("server.network.public-port.write")
    expect(
      instancePortsWritePermission([
        { externalPort: 32_124, id: "custom-allocation" },
      ])
    ).toBe("server.network.public-port.write")
    expect(instancePortsWritePermission([{ externalPort: 32_124 }])).toBe(
      "server.network.write"
    )
    expect(instancePortsWritePermission([{ id: "primary" }])).toBe(
      "server.network.write"
    )
  })
})
