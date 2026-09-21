import { describe, expect, it } from "vite-plus/test"

import type { ScheduleAction, ScheduleTarget } from "@workspace/contracts"

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
})
