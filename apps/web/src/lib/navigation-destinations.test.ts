import { describe, expect, it } from "vite-plus/test"
import { builtinTailscaleBrickId } from "@workspace/contracts"

import {
  accessibleDestinationsForServer,
  accessibleInfrastructureDestinations,
  canAccessActivity,
  canAccessInstancePermission,
  destinationsForServer,
  sectionDestinationLabel,
  serverDestinationHref,
  serverDestinations,
} from "@/lib/navigation-destinations"
import type { NavigationAccessCapabilities } from "@/lib/navigation-destinations"

const operatorRelayAccess = {
  canManageAccess: false,
  canManageRelays: false,
  grants: [
    {
      relayId: "relay-one",
      resourceId: "relay-one",
      resourceType: "relay",
      role: "operator",
    },
  ],
  isPlatformAdmin: false,
} satisfies NavigationAccessCapabilities

const databaseViewerAccess = {
  canManageAccess: false,
  canManageRelays: false,
  grants: [
    {
      relayId: "relay-one",
      resourceId: "database-one",
      resourceType: "database",
      role: "viewer",
    },
  ],
  isPlatformAdmin: false,
} satisfies NavigationAccessCapabilities

describe("navigation destinations", () => {
  it.each([
    ["relay", ["relay.audit.read"], true],
    ["relay", ["instance.read"], true],
    ["instance", ["instance.read"], true],
    ["relay", ["relay.read"], false],
    ["instance", ["relay.audit.read"], false],
    ["database", ["database.read"], false],
  ] as const)(
    "checks Activity permission and scope for %s with %s",
    (resourceType, permissions, allowed) => {
      expect(
        canAccessActivity({
          ...operatorRelayAccess,
          grants: [
            {
              relayId: "relay-one",
              resourceId: "resource-one",
              resourceType,
              role: "viewer",
              permissions: [...permissions],
            },
          ],
        })
      ).toBe(allowed)
    }
  )

  it("uses the complete server workspace list for regular servers", () => {
    expect(
      destinationsForServer({ brickId: "paper" }).map(({ id }) => id)
    ).toEqual(serverDestinations.map(({ id }) => id))
  })

  it("uses only supported workspace destinations for network stacks", () => {
    expect(
      destinationsForServer({ brickId: builtinTailscaleBrickId }).map(
        ({ id }) => id
      )
    ).toEqual(["console", "files", "network"])
  })

  it("hides server destinations that the effective grant cannot read", () => {
    expect(
      accessibleDestinationsForServer(
        { brickId: "paper", id: "server-one", relayId: "relay-one" },
        operatorRelayAccess
      ).map(({ id }) => id)
    ).toEqual(["console", "files", "network", "info"])
  })

  it("shows Startup for configuration readers and checks each power action independently", () => {
    const instance = {
      brickId: "paper",
      id: "server-one",
      relayId: "relay-one",
    }
    const access: NavigationAccessCapabilities = {
      ...operatorRelayAccess,
      grants: [
        {
          relayId: instance.relayId,
          resourceId: instance.id,
          resourceType: "instance",
          role: "viewer",
          permissions: [
            "instance.read",
            "instance.configuration.read",
            "instance.power.start",
          ],
        },
      ],
    }
    expect(
      accessibleDestinationsForServer(instance, access).map(({ id }) => id)
    ).toContain("startup")
    expect(
      canAccessInstancePermission(access, instance, "instance.power.start")
    ).toBe(true)
    for (const action of ["stop", "restart", "kill"] as const)
      expect(
        canAccessInstancePermission(
          access,
          instance,
          `instance.power.${action}`
        )
      ).toBe(false)
    expect(
      canAccessInstancePermission(
        access,
        instance,
        "instance.configuration.write"
      )
    ).toBe(false)
  })

  it("does not expose restart or kill through a stop-only selection", () => {
    const instance = { id: "server-one", relayId: "relay-one" }
    const access: NavigationAccessCapabilities = {
      ...operatorRelayAccess,
      grants: [
        {
          relayId: instance.relayId,
          resourceId: instance.id,
          resourceType: "instance",
          role: "admin",
          permissions: ["instance.power.start", "instance.power.stop"],
        },
      ],
    }
    expect(
      canAccessInstancePermission(access, instance, "instance.power.stop")
    ).toBe(true)
    expect(
      canAccessInstancePermission(access, instance, "instance.power.restart")
    ).toBe(false)
    expect(
      canAccessInstancePermission(access, instance, "instance.power.kill")
    ).toBe(false)
  })

  it("shows only infrastructure destinations matching the grant scope", () => {
    expect(
      accessibleInfrastructureDestinations(databaseViewerAccess).map(
        ({ label }) => label
      )
    ).toEqual(["Databases"])
    expect(canAccessActivity(databaseViewerAccess)).toBe(false)
  })

  it("shows pending infrastructure without granting server operation navigation", () => {
    const pending: NavigationAccessCapabilities = {
      canManageAccess: false,
      canManageRelays: false,
      isPlatformAdmin: false,
      grants: [],
      pendingScopes: [
        {
          relayId: "relay-one",
          resourceType: "instance",
          resourceId: "server-one",
          invitationId: "invitation-one",
        },
      ],
    }
    expect(
      accessibleInfrastructureDestinations(pending).map(({ label }) => label)
    ).toEqual(["Servers"])
    expect(
      accessibleDestinationsForServer(
        { brickId: "paper", id: "server-one", relayId: "relay-one" },
        pending
      )
    ).toEqual([])
  })

  it("builds encoded server destination URLs", () => {
    const files = serverDestinations.find(({ id }) => id === "files")
    const console = serverDestinations.find(({ id }) => id === "console")

    expect(files).toBeDefined()
    expect(console).toBeDefined()
    expect(serverDestinationHref(files!, "relay one/server")).toBe(
      "/server/relay%20one%2Fserver/files/"
    )
    expect(serverDestinationHref(console!, "relay one/server")).toBe(
      "/server/relay%20one%2Fserver/console"
    )
  })

  it("resolves section titles from the shared destinations", () => {
    expect(sectionDestinationLabel("infra", "/infra/tailscale/network")).toBe(
      "Tailscale"
    )
    expect(sectionDestinationLabel("settings", "/settings/files")).toBe("Files")
    expect(sectionDestinationLabel("automations", "/activity")).toBeNull()
  })
})
