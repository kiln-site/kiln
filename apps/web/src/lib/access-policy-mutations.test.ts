import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { describe, expect, it } from "vite-plus/test"

import type { DatabaseTransaction } from "@/effect/database"
import {
  assertDelegation,
  resolveAssignmentEffect,
} from "@/lib/access-policy-mutations"
import type { ResourceScope } from "@/lib/resource-permissions"

const scope: ResourceScope = {
  relayId: "relay",
  resourceType: "instance",
  resourceId: "server",
}

function presetFixture(presetScope: ResourceScope, permissions: string[]) {
  const parameters: Array<ReadonlyArray<unknown>> = []
  const transaction: DatabaseTransaction = {
    execute: () => Effect.die("Assignment resolution must not mutate state"),
    queryRows: <T extends RowDataPacket>(
      sql: string,
      values: Parameters<DatabaseTransaction["queryRows"]>[1] = []
    ) =>
      Effect.sync(() => {
        parameters.push(values)
        if (sql.includes("permission_preset")) {
          const matches =
            values[1] === presetScope.relayId &&
            values[2] === presetScope.resourceType &&
            values[3] === presetScope.resourceId
          return (matches
            ? [{ id: "preset" }]
            : []) as unknown as ReadonlyArray<T>
        }
        return permissions.map((key) => ({
          selection_kind: "permission",
          selection_key: key,
        })) as unknown as ReadonlyArray<T>
      }),
  }
  return { transaction, parameters }
}

describe("delegation boundaries", () => {
  it("preserves actionable invalid-selection errors across the Effect boundary", async () => {
    const data = presetFixture(scope, [])
    const error = await Effect.runPromise(
      resolveAssignmentEffect(data.transaction, scope, {
        selections: [{ kind: "permission", key: "not-a-permission" }],
        presetIds: [],
        builtinKeys: [],
      }).pipe(Effect.flip)
    )
    expect(error.message).toContain("not-a-permission")
    expect(error.message).not.toContain("Effect.try")
  })
  it("reports an invalid built-in preset without an Effect defect", async () => {
    const data = presetFixture(scope, [])
    const error = await Effect.runPromise(
      resolveAssignmentEffect(data.transaction, scope, {
        selections: [],
        presetIds: [],
        builtinKeys: ["missing-preset"],
      }).pipe(Effect.flip)
    )
    expect(error.message).toBe("Unknown built-in preset: missing-preset")
  })

  it("rejects self-escalation even when an actor can manage access", () => {
    expect(() =>
      assertDelegation(new Set(["access.manage"]), [
        "access.manage",
        "instance.delete",
      ])
    ).toThrow("instance.delete")
  })

  it("allows reductions of existing broader authority without granting new authority", () => {
    expect(() =>
      assertDelegation(
        new Set(["access.manage"]),
        ["instance.files.read"],
        ["instance.files.read", "instance.delete"]
      )
    ).not.toThrow()
    expect(() =>
      assertDelegation(
        new Set(["access.manage"]),
        ["instance.files.read", "instance.files.write"],
        ["instance.files.read", "instance.delete"]
      )
    ).toThrow("instance.files.write")
  })

  it.each([
    { ...scope, relayId: "other-relay" },
    { ...scope, resourceId: "other-server" },
    { ...scope, resourceType: "database" as const },
  ])(
    "refuses a preset owned by a different exact scope: %j",
    async (presetScope) => {
      const data = presetFixture(presetScope, ["instance.delete"])
      await expect(
        Effect.runPromise(
          resolveAssignmentEffect(data.transaction, scope, {
            selections: [],
            presetIds: ["preset"],
            builtinKeys: [],
          })
        )
      ).rejects.toThrow("Presets must belong to this resource")
      expect(data.parameters).toHaveLength(1)
    }
  )

  it("unions and deduplicates local and shared selections for a same-scope preset", async () => {
    const data = presetFixture(
      scope,
      Array.from({ length: 1000 }, () => "instance.files.read")
    )
    const permissions = await Effect.runPromise(
      resolveAssignmentEffect(data.transaction, scope, {
        selections: [
          { kind: "permission", key: "instance.files.read" },
          { kind: "permission", key: "instance.console.read" },
        ],
        presetIds: ["preset", "preset"],
        builtinKeys: [],
      })
    )
    expect(permissions).toContain("instance.console.read")
    expect(
      permissions.filter((key) => key === "instance.files.read")
    ).toHaveLength(1)
    expect(data.parameters).toHaveLength(2)
  })
})
