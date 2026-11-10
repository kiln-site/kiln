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
    expect(child).not.toContain("database.credentials.read")
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

describe("file permissions", () => {
  it("show the Apps they reach on a Relay, and nothing beyond one game server", () => {
    const files = (scope: "instance" | "relay") =>
      expandPermissionSelections(
        [{ kind: "permission", key: "instance.files.read" }],
        scope
      )
    expect(files("relay")).toEqual(
      expect.arrayContaining(["instance.read", "app.read"])
    )
    expect(files("instance")).toContain("instance.read")
    expect(files("instance")).not.toContain("app.read")
    // Everything about Apps no longer carries their files.
    expect(
      expandPermissionSelections(
        [{ kind: "collection", key: "app.all" }],
        "relay"
      )
    ).not.toContain("instance.files.read")
  })
})

describe("power permissions", () => {
  const power = (
    key: "instance.power.restart" | "instance.power.kill",
    scope: "database" | "instance" | "relay"
  ) => expandPermissionSelections([{ kind: "permission", key }], scope)

  it("can be given on one database, and show only that database there", () => {
    const restart = power("instance.power.restart", "database")
    expect(restart).toEqual(
      expect.arrayContaining([
        "database.read",
        "instance.power.restart",
        "instance.power.stop",
        "instance.power.start",
      ])
    )
    expect(restart).not.toContain("instance.power.kill")
    expect(restart).not.toContain("instance.read")
    expect(restart).not.toContain("app.read")
  })

  it("show every kind they reach on a Relay, and only the game server on one", () => {
    expect(power("instance.power.kill", "relay")).toEqual(
      expect.arrayContaining(["instance.read", "database.read", "app.read"])
    )
    const server = power("instance.power.kill", "instance")
    expect(server).toContain("instance.read")
    expect(server).not.toContain("database.read")
    expect(server).not.toContain("app.read")
  })

  it("come with everything about databases, and not with configuring Apps", () => {
    const all = (key: string) =>
      expandPermissionSelections([{ kind: "collection", key }], "relay")
    expect(all("database.all")).toContain("instance.power.kill")
    expect(all("app.all")).not.toContain("instance.power.start")
    expect(
      expandPermissionSelections(
        [{ kind: "permission", key: "app.manage" }],
        "relay"
      )
    ).not.toContain("instance.power.start")
  })
})

describe("the deploy permission", () => {
  const expand = (key: string, scope: "database" | "instance" | "relay") =>
    expandPermissionSelections(
      [{ kind: key.endsWith(".all") ? "collection" : "permission", key }],
      scope
    )

  it("can be given on one database, and reaches every kind from a Relay", () => {
    const database = expand("instance.deploy", "database")
    expect(database).toEqual(
      expect.arrayContaining(["database.read", "instance.deploy"])
    )
    expect(database).not.toContain("instance.read")
    expect(expand("instance.deploy", "relay")).toEqual(
      expect.arrayContaining(["instance.read", "database.read", "app.read"])
    )
  })

  it("doesn't come with configuring an App or a game server, or with power", () => {
    expect(expand("app.manage", "relay")).not.toContain("instance.deploy")
    expect(expand("app.all", "relay")).not.toContain("instance.deploy")
    expect(expand("instance.configuration.write", "instance")).not.toContain(
      "instance.deploy"
    )
    expect(expand("instance.power.kill", "relay")).not.toContain(
      "instance.deploy"
    )
    // Nor does it configure or power what it deploys.
    const deploy = expand("instance.deploy", "relay")
    expect(deploy).not.toContain("app.manage")
    expect(deploy).not.toContain("instance.configuration.write")
    expect(deploy).not.toContain("instance.power.start")
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
