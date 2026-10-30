import { describe, expect, it } from "vite-plus/test"

import {
  accessPermissionSupported,
  expandPermissionSelections,
  permissionsForRelayClientPolicy,
  permissionScopeTypes,
} from "./access-permissions"

describe("permission catalog boundaries", () => {
  it("expands transitive implications without unrelated authority", () => {
    const permissions = expandPermissionSelections(
      [
        { kind: "permission", key: "instance.power.stop" },
        { kind: "permission", key: "instance.files.write" },
        { kind: "permission", key: "access.invite" },
      ],
      "instance"
    )
    expect(permissions).toEqual(
      expect.arrayContaining([
        "instance.read",
        "instance.power.stop",
        "instance.power.start",
        "instance.files.read",
        "access.read",
        "preset.read",
        "preset.create",
      ])
    )
    for (const key of [
      "instance.power.kill",
      "instance.files.delete",
      "preset.manage",
      "access.manage",
      "relay.read",
      "database.read",
    ]) {
      expect(permissions).not.toContain(key)
    }
  })

  it("keeps ALL inside the target and excludes platform and ownership authority", () => {
    for (const scope of permissionScopeTypes) {
      const permissions = expandPermissionSelections(
        [{ kind: "collection", key: "all" }],
        scope
      )
      expect(permissions.length).toBeGreaterThan(0)
      expect(
        permissions.every((key) => accessPermissionSupported(key, scope))
      ).toBe(true)
      expect(
        permissions.some(
          (key) => key.startsWith("platform.") || key.includes("owner")
        )
      ).toBe(false)
    }
    const child = expandPermissionSelections(
      [{ kind: "collection", key: "instance.all" }],
      "relay"
    )
    expect(child).not.toContain("relay.configure")
    expect(child).not.toContain("database.read")
    expect(child).not.toContain("instance.create")
    // Collections carry granular keys only; compatibility umbrellas stay out.
    expect(child).not.toContain("instance.power")
    expect(child).not.toContain("instance.settings")
    expect(child).toContain("instance.power.kill")
    expect(child).toContain("instance.configuration.write")
    // Any Relay-scope assignment reveals the Relay it was granted on.
    expect(child).toContain("relay.read")
  })
})

describe("machine policy delegation", () => {
  it("requires full scoped authority for clients that can mint unrestricted clients", () => {
    const full = permissionsForRelayClientPolicy("full_access")
    expect(
      permissionsForRelayClientPolicy("custom", ["relay.pairing.create"])
    ).toEqual(full)
    expect(full.some((permission) => permission.startsWith("platform."))).toBe(
      false
    )
  })
})
