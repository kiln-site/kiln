import { describe, expect, it } from "vite-plus/test"

import {
  accessPermissionSupported,
  builtinPermissionPresets,
  builtinPresetSelections,
  expandPermissionSelections,
  permissionCatalog,
  permissionsForRelayClientPolicy,
  permissionCollections,
  permissionScopeTypes,
  validatePermissionCatalog,
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
    expect(child).toContain("instance.power")
    expect(child).toContain("instance.settings")
  })

  it("rejects unknown, unsupported, malformed and oversized selections", () => {
    for (const key of [
      "platform.bricks.add-custom",
      "unknown",
      "relay.configure",
      "database.create",
    ]) {
      expect(() =>
        expandPermissionSelections([{ kind: "permission", key }], "instance")
      ).toThrow()
    }
    expect(() =>
      expandPermissionSelections(
        [{ kind: "collection", key: "relay.all" }],
        "instance"
      )
    ).toThrow()
    expect(() =>
      expandPermissionSelections(
        [{ kind: "collection", key: "unknown" }],
        "instance"
      )
    ).toThrow()
    expect(() =>
      expandPermissionSelections(
        Array.from({ length: 257 }, () => ({
          kind: "permission",
          key: "instance.read",
        })),
        "instance"
      )
    ).toThrow()
  })

  it("rejects reference cycles and stale catalog references", () => {
    expect(() => validatePermissionCatalog()).not.toThrow()
    expect(() =>
      validatePermissionCatalog(permissionCatalog, [
        {
          key: "a",
          label: "A",
          scopeTypes: ["instance"],
          selections: [{ kind: "collection", key: "b" }],
        },
        {
          key: "b",
          label: "B",
          scopeTypes: ["instance"],
          selections: [{ kind: "collection", key: "a" }],
        },
      ])
    ).toThrow(/cycle/)
    expect(() =>
      validatePermissionCatalog(permissionCatalog, [
        {
          key: "a",
          label: "A",
          scopeTypes: ["instance"],
          selections: [{ kind: "permission", key: "missing" }],
        },
      ])
    ).toThrow(/Unknown/)
  })

  it("projects immutable defaults and preserves collection selections", () => {
    for (const preset of builtinPermissionPresets) {
      expect(Object.isFrozen(preset.selections)).toBe(true)
      for (const scope of permissionScopeTypes) {
        expect(() =>
          expandPermissionSelections(
            builtinPresetSelections(preset.key, scope),
            scope
          )
        ).not.toThrow()
      }
    }
    expect(builtinPresetSelections("kiln.administrator", "instance")).toEqual([
      { kind: "collection", key: "all" },
    ])
    const observer = expandPermissionSelections(
      builtinPresetSelections("kiln.observer", "instance"),
      "instance"
    )
    expect(observer).not.toContain("instance.files.read")
    expect(observer).not.toContain("backup.download")
    expect(Object.isFrozen(permissionCollections[0].selections)).toBe(true)
  })

  it("filters unsupported operations from ALL and rejects explicit unsupported selections", () => {
    const all = [{ kind: "collection" as const, key: "all" }]
    expect(expandPermissionSelections(all, "database", [])).not.toContain(
      "database.dump.export"
    )
    expect(
      expandPermissionSelections(all, "database", ["database.logical-backups"])
    ).toContain("database.dump.export")
    expect(() =>
      expandPermissionSelections(
        [{ kind: "permission", key: "database.dump.export" }],
        "database",
        []
      )
    ).toThrow()
  })

  it("requires logical backup capability when engine support is supplied", () => {
    expect(
      accessPermissionSupported("database.dump.export", "database", [])
    ).toBe(false)
    expect(
      accessPermissionSupported("database.dump.export", "database", [
        "database.logical-backups",
      ])
    ).toBe(true)
  })
})

describe("machine policy delegation", () => {
  it("keeps file editing separate from deletion and rejects unknown actions", () => {
    const editing = permissionsForRelayClientPolicy("custom", [
      "instance.files.write",
    ])
    expect(editing).toContain("instance.files.read")
    expect(editing).not.toContain("instance.files.delete")
    expect(() =>
      permissionsForRelayClientPolicy("custom", ["not-a-permission"])
    ).toThrow()
  })
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
