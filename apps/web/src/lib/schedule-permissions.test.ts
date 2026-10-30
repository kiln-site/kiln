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

const consoleAction: ScheduleAction = {
  command: "say hello",
  id: "d3efe0a8-2dd5-4c21-bb10-c700e4807130",
  type: "console_command",
}

describe("schedule authorization", () => {
  it("runs a database command only for those with a terminal on its Relay", () => {
    const database: ScheduleTarget = {
      id: "database-a",
      kind: "database",
      name: "Main database",
      relayId: "relay-a",
    }
    const databaseGrant: AccessGrant = {
      id: "grant",
      relayId: "relay-a",
      resourceId: "database-a",
      resourceType: "database",
      permissions: ["schedule.create", "database.terminal", "database.power"],
    }
    const relayGrant: AccessGrant = {
      id: "relay-grant",
      relayId: "relay-a",
      resourceId: "relay-a",
      resourceType: "relay",
      permissions: ["schedule.create", "relay.terminal"],
    }
    const named: ScheduleAction = {
      ...consoleAction,
      authorizedTargets: 2,
      targetKeys: ["relay-a:database:database-a"],
    }
    const input = {
      actions: [named],
      schedulePermission: "schedule.create",
      targets: [database],
      user,
    } as const

    expect(
      scheduleAuthorizationFailure({ ...input, grants: [databaseGrant] })
    ).toContain("relay.terminal")
    expect(
      scheduleAuthorizationFailure({ ...input, grants: [relayGrant] })
    ).toBeNull()
  })

  it("schedules an App's commands and power only with the authority its terminal and power take", () => {
    const app: ScheduleTarget = {
      id: "a".repeat(40),
      kind: "app",
      name: "Website",
      relayId: "relay-a",
    }
    const command: ScheduleAction = {
      ...consoleAction,
      authorizedTargets: 2,
      services: { [`relay-a:app:${app.id}`]: "web" },
      targetKeys: [`relay-a:app:${app.id}`],
    }
    const stop: ScheduleAction = {
      action: "stop",
      id: "6c04b8d6-873a-4206-a5d2-010bc0124a06",
      type: "power",
    }
    const relayGrant = (
      permissions: NonNullable<AccessGrant["permissions"]>
    ): AccessGrant => ({
      id: "relay-grant",
      relayId: "relay-a",
      resourceId: "relay-a",
      resourceType: "relay",
      permissions: ["schedule.create", ...permissions],
    })
    const failure = (
      actions: ReadonlyArray<ScheduleAction>,
      grants: ReadonlyArray<AccessGrant>
    ) =>
      scheduleAuthorizationFailure({
        actions,
        grants,
        schedulePermission: "schedule.create",
        targets: [app],
        user,
      })

    expect(failure([command], [relayGrant(["app.manage"])])).toContain(
      "app.terminal"
    )
    expect(failure([stop], [relayGrant(["app.terminal"])])).toContain(
      "app.manage"
    )
    expect(
      failure([command, stop], [relayGrant(["app.terminal", "app.manage"])])
    ).toBeNull()
    // Without Hearth's mark, a command step never reaches the App, so it
    // takes nothing of it.
    expect(
      failure([{ ...command, authorizedTargets: undefined }], [relayGrant([])])
    ).toBeNull()
    // Owning an App grants neither its shell nor its power.
    expect(
      failure(
        [stop],
        [
          relayGrant([]),
          {
            id: `owner:app:${app.id}`,
            relayId: "relay-a",
            resourceId: app.id,
            resourceType: "app",
            permissions: ["app.read", "app.logs.read", "app.delete"],
          },
        ]
      )
    ).toContain("app.manage")
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

    expect(scheduleAuthorizationFailure({ ...input, user })).not.toBeNull()
    expect(
      scheduleAuthorizationFailure({
        ...input,
        user: { ...user, role: "admin" },
      })
    ).toBeNull()
  })
})
