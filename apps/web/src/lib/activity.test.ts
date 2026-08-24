import { describe, expect, it } from "vite-plus/test"
import type { RelayAuditRecord } from "@workspace/contracts"

import {
  auditInstanceCreatorId,
  activityLocalRangeToUtc,
  activityLabelForAudit,
  activityPermissionForAudit,
  activitySourceForAudit,
  activityTypeForAudit,
  scopeAllowsAudit,
} from "@/lib/activity"

function audit(
  details: RelayAuditRecord["details"],
  event = "control.mutation"
): RelayAuditRecord {
  return {
    clientId: "hearth",
    details,
    event,
    id: "audit",
    occurredAt: 1,
    requestId: "request",
  }
}

describe("activity", () => {
  it("recognizes synchronous and prepared instance creation as ownership evidence", () => {
    expect(
      auditInstanceCreatorId(
        audit({
          instanceId: "server-a",
          operation: "instance.create",
          subject: "creator-a",
        }),
        "server-a"
      )
    ).toBe("creator-a")
    expect(
      auditInstanceCreatorId(
        audit({
          instanceId: "server-a",
          operation: "instance.provision.prepare",
          subject: "creator-a",
        }),
        "server-a"
      )
    ).toBe("creator-a")
    expect(
      auditInstanceCreatorId(
        audit({
          instanceId: "server-a",
          operation: "instance.startup.write",
          permission: "instance.create",
          subject: "editor-b",
        }),
        "server-a"
      )
    ).toBeNull()
    expect(
      auditInstanceCreatorId(
        audit({
          instanceId: "server-b",
          operation: "instance.create",
          subject: "creator-b",
        }),
        "server-a"
      )
    ).toBeNull()
  })

  it("never exposes unknown or other-server scope to an instance-only user", () => {
    const scope = {
      allInstances: false,
      instanceIds: new Set(["server-a"]),
    }

    expect(scopeAllowsAudit(scope, audit({ operation: "relay.rename" }))).toBe(
      false
    )
    expect(
      scopeAllowsAudit(
        scope,
        audit({ instanceId: "server-b", operation: "instance.rename" })
      )
    ).toBe(false)
    expect(
      scopeAllowsAudit(
        scope,
        audit({ instanceId: "server-a", operation: "instance.rename" })
      )
    ).toBe(true)
  })

  it("classifies and labels existing Relay mutation records", () => {
    const record = audit({
      action: "restart",
      instanceId: "server-a",
      operation: "instance.action",
    })
    expect(activityTypeForAudit(record)).toBe("power")
    expect(activityLabelForAudit(record)).toBe("Restarted a server")
    expect(activityPermissionForAudit(record)).toBe("instance.power.restart")
  })

  it("labels a Brick reinstall separately from other startup writes", () => {
    expect(
      activityLabelForAudit(
        audit({
          instanceId: "server-a",
          operation: "instance.startup.write",
          reinstall: true,
        })
      )
    ).toBe("Reinstalled a server Brick")
    expect(
      activityLabelForAudit(
        audit({
          instanceId: "server-a",
          operation: "instance.startup.write",
        })
      )
    ).toBe("Updated server startup settings")
  })

  it("uses the recorded permission when the audit provides one", () => {
    const record = audit(
      {
        instanceId: "instance-1",
        permission: "instance.console.write",
      },
      "browser.console.write"
    )

    expect(activityPermissionForAudit(record)).toBe("instance.console.write")
  })

  it("only classifies explicitly attributed Relay audits as CLI activity", () => {
    expect(activitySourceForAudit(audit({ source: "cli" }))).toBe("cli")
    expect(activitySourceForAudit(audit({ source: "web" }))).toBe("web")
    expect(activitySourceForAudit(audit({ source: "unknown" }))).toBe("web")
  })

  it("converts local calendar days to exact UTC query bounds", () => {
    const from = new Date(2026, 2, 7, 12)
    const to = new Date(2026, 2, 9, 12)
    const range = activityLocalRangeToUtc(from, to)
    const start = new Date(range.from)
    const end = new Date(range.to)

    expect([
      start.getFullYear(),
      start.getMonth(),
      start.getDate(),
      start.getHours(),
      start.getMinutes(),
      start.getSeconds(),
      start.getMilliseconds(),
    ]).toEqual([2026, 2, 7, 0, 0, 0, 0])
    expect([
      end.getFullYear(),
      end.getMonth(),
      end.getDate(),
      end.getHours(),
      end.getMinutes(),
      end.getSeconds(),
      end.getMilliseconds(),
    ]).toEqual([2026, 2, 9, 23, 59, 59, 999])
  })
})
