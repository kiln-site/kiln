import { describe, expect, it } from "vite-plus/test"
import {
  accessPermissionSupported,
  accessPermissions,
} from "@workspace/contracts"

import {
  accessibleDestinationsForServer,
  accessibleInfrastructureDestinations,
  canAccessAccessManagement,
  canAccessActivity,
  canAccessAutomations,
  canAccessBackups,
  canAccessInstancePermission,
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
      permissions: [
        "instance.read",
        "instance.console.read",
        "instance.files.read",
        "instance.network.read",
      ],
    },
  ],
  isPlatformAdmin: false,
  isRelayCreator: false,
} satisfies NavigationAccessCapabilities

const databaseViewerAccess = {
  canManageAccess: false,
  canManageRelays: false,
  grants: [
    {
      relayId: "relay-one",
      resourceId: "database-one",
      resourceType: "database",
      permissions: ["database.read"],
    },
  ],
  isPlatformAdmin: false,
  isRelayCreator: false,
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
              permissions: [...permissions],
            },
          ],
        })
      ).toBe(allowed)
    }
  )

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
          permissions: [
            "instance.read",
            "instance.configuration.read",
            "instance.power.start",
            "instance.power.stop",
          ],
        },
      ],
    }
    expect(
      accessibleDestinationsForServer(instance, access).map(({ id }) => id)
    ).toContain("startup")
    for (const action of ["start", "stop"] as const)
      expect(
        canAccessInstancePermission(
          access,
          instance,
          `instance.power.${action}`
        )
      ).toBe(true)
    for (const action of ["restart", "kill"] as const)
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

  it("shows only infrastructure destinations matching the grant scope", () => {
    expect(
      accessibleInfrastructureDestinations(databaseViewerAccess).map(
        ({ to }) => to
      )
    ).toEqual(["/infra/databases"])
    expect(canAccessActivity(databaseViewerAccess)).toBe(false)
  })

  it("shows pending infrastructure without granting server operation navigation", () => {
    const pending: NavigationAccessCapabilities = {
      canManageAccess: false,
      canManageRelays: false,
      isPlatformAdmin: false,
      isRelayCreator: false,
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
      accessibleInfrastructureDestinations(pending).map(({ to }) => to)
    ).toEqual(["/infra/servers"])
    expect(
      accessibleDestinationsForServer(
        { brickId: "paper", id: "server-one", relayId: "relay-one" },
        pending
      )
    ).toEqual([])
  })

  it.each([
    ["database.create", ["/infra/databases"]],
    ["app.create", ["/infra/apps", "/infra/deployments"]],
    ["instance.create", ["/infra/servers"]],
    // Relay access alone doesn't open a list of what it can't reach.
    ["database.read", ["/infra/databases"]],
  ] as const)(
    "opens the lists a Relay grant of %s can use",
    (permission, lists) => {
      const access: NavigationAccessCapabilities = {
        ...operatorRelayAccess,
        // Every Relay grant reveals the Relay itself.
        canManageRelays: true,
        grants: [
          {
            relayId: "relay-one",
            resourceId: "relay-one",
            resourceType: "relay",
            permissions: [permission, "relay.read"],
          },
        ],
      }
      expect(
        accessibleInfrastructureDestinations(access)
          .map(({ to }) => to)
          .filter((to) =>
            [
              "/infra/databases",
              "/infra/servers",
              "/infra/apps",
              "/infra/deployments",
            ].includes(to)
          )
      ).toEqual(lists)
    }
  )

  it("shows a Relay Creator the workspace their first Relay will open", () => {
    const relayCreator: NavigationAccessCapabilities = {
      canManageAccess: true,
      canManageRelays: true,
      grants: [],
      isPlatformAdmin: false,
      isRelayCreator: true,
    }
    // Pairing a Relay adds an owner grant with every Relay permission.
    const relayOwner: NavigationAccessCapabilities = {
      ...relayCreator,
      grants: [
        {
          relayId: "relay-one",
          resourceId: "relay-one",
          resourceType: "relay",
          permissions: accessPermissions.filter((permission) =>
            accessPermissionSupported(permission, "relay")
          ),
        },
      ],
    }
    const navigation = (capabilities: NavigationAccessCapabilities) => ({
      access: canAccessAccessManagement(capabilities),
      activity: canAccessActivity(capabilities),
      automations: canAccessAutomations(capabilities),
      backups: canAccessBackups(capabilities),
      infrastructure: accessibleInfrastructureDestinations(capabilities).map(
        ({ to }) => to
      ),
    })

    expect(navigation(relayCreator)).toEqual(navigation(relayOwner))
    expect(navigation(relayCreator)).toEqual({
      access: true,
      activity: true,
      automations: true,
      backups: true,
      infrastructure: [
        "/infra/overview",
        "/infra/relays",
        "/infra/databases",
        "/infra/servers",
        "/infra/apps",
        "/infra/sources",
        "/infra/deployments",
      ],
    })
    // The role grants nothing on Relays it doesn't own.
    expect(
      canAccessInstancePermission(
        relayCreator,
        { id: "server-one", relayId: "relay-two" },
        "instance.read"
      )
    ).toBe(false)
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
})
