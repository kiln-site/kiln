import { describe, expect, it } from "vite-plus/test"
import type { RelayAuditRecord } from "@workspace/contracts"

import { auditInstanceCreatorId, scopeAllowsAudit } from "@/lib/activity"

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
      relayAudit: false,
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
})
