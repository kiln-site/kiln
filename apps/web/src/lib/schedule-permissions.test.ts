import { describe, expect, it } from "vite-plus/test"

import type {
  ScheduleAction,
  ScheduleTarget,
} from "@workspace/contracts/schedules"

import type { AuthenticatedUser } from "./auth-session"
import type { AccessGrant } from "./access-control"
import { scheduleAuthorizationFailure } from "./schedule-permissions"

const user: AuthenticatedUser = {
  email: "operator@example.test",
  emailVerified: true,
  id: "operator",
  isDevelopmentBypass: false,
  name: "Operator",
  role: "user",
  twoFactorEnabled: false,
}

const target: ScheduleTarget = {
  id: "server-a",
  kind: "instance",
  name: "Server A",
  relayId: "relay-a",
}

const consoleAction: ScheduleAction = {
  command: "say hello",
  id: "d3efe0a8-2dd5-4c21-bb10-c700e4807130",
  type: "console_command",
}

function grant(
  permissions: NonNullable<AccessGrant["permissions"]>
): AccessGrant {
  return {
    id: "grant",
    relayId: "relay-a",
    resourceId: "server-a",
    resourceType: "instance",
    permissions,
  }
}

describe("schedule authorization", () => {
  it("allows an operator to schedule actions they can perform", () => {
    expect(
      scheduleAuthorizationFailure({
        actions: [consoleAction],
        grants: [grant(["schedule.create", "instance.console.write"])],
        schedulePermission: "schedule.create",
        targets: [target],
        user,
      })
    ).toBeNull()
  })

  it("blocks editing when any stored action is no longer permitted", () => {
    expect(
      scheduleAuthorizationFailure({
        actions: [consoleAction],
        grants: [grant(["instance.console.write"])],
        schedulePermission: "schedule.update",
        targets: [target],
        user,
      })
    ).toContain("schedule.update")
  })

  it("blocks power scheduling without the power permission", () => {
    const power: ScheduleAction = {
      action: "restart",
      id: "6c04b8d6-873a-4206-a5d2-010bc0124a06",
      type: "power",
    }
    expect(
      scheduleAuthorizationFailure({
        actions: [power],
        grants: [grant(["schedule.create"])],
        schedulePermission: "schedule.create",
        targets: [target],
        user,
      })
    ).not.toBeNull()
  })

  it("requires execute and action permissions to run now", () => {
    expect(
      scheduleAuthorizationFailure({
        actions: [consoleAction],
        grants: [grant(["schedule.execute", "instance.console.write"])],
        schedulePermission: "schedule.execute",
        targets: [target],
        user,
      })
    ).toBeNull()
    expect(
      scheduleAuthorizationFailure({
        actions: [consoleAction],
        grants: [grant(["instance.console.write"])],
        schedulePermission: "schedule.execute",
        targets: [target],
        user,
      })
    ).toContain("schedule.execute")
  })

  it("needs backup deletion to keep backups for only so long", () => {
    const backup: ScheduleAction = {
      destination: { kind: "local" },
      id: "4f9a1f0e-55c4-4d7b-9a43-1d2f0b6f2e11",
      mode: "full",
      name: "Nightly",
      type: "backup",
    }
    const retained: ScheduleAction = {
      ...backup,
      retention: { bytes: null, days: 7 },
    }
    const check = (
      action: ScheduleAction,
      permissions: NonNullable<AccessGrant["permissions"]>
    ) =>
      scheduleAuthorizationFailure({
        actions: [action],
        grants: [grant(permissions)],
        schedulePermission: "schedule.update",
        targets: [target],
        user,
      })

    expect(check(backup, ["schedule.update", "backup.create"])).toBeNull()
    expect(check(retained, ["schedule.update", "backup.create"])).toBe(
      "You do not have backup.delete permission for Server A"
    )
    expect(
      check(retained, ["schedule.update", "backup.create", "backup.delete"])
    ).toBeNull()
  })

  it("keeps Kiln's backups to platform administrators, whatever a Relay grant allows", () => {
    const kiln: ScheduleTarget = {
      id: "relay-a",
      kind: "relay",
      name: "Kiln",
      relayId: "relay-a",
    }
    const relayGrant: AccessGrant = {
      id: "grant",
      relayId: "relay-a",
      resourceId: "relay-a",
      resourceType: "relay",
      permissions: ["schedule.create", "backup.create"],
    }
    const input = {
      actions: [],
      grants: [relayGrant],
      schedulePermission: "schedule.create",
      targets: [kiln],
    } as const

    expect(scheduleAuthorizationFailure({ ...input, user })).toBe(
      "Only a platform administrator can schedule Kiln's backups"
    )
    expect(
      scheduleAuthorizationFailure({
        ...input,
        user: { ...user, role: "admin" },
      })
    ).toBeNull()
  })
})
