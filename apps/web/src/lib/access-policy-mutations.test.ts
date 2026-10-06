import { describe, expect, it, layer } from "@effect/vitest"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import {
  assertDelegation,
  resolveAssignmentEffect,
} from "@/lib/access-policy-mutations"
import type { ResourceScope } from "@/lib/resource-permissions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

const scope: ResourceScope = {
  relayId: "relay",
  resourceType: "instance",
  resourceId: "server",
}

describe("delegation boundaries", () => {
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
})

describeMysql("preset scope", () => {
  layer(TestDatabase)((it) => {
    const resolvePresets = (presetIds: Array<string>) =>
      Effect.gen(function* () {
        const database = yield* Database
        return yield* database.transaction("test", (transaction) =>
          resolveAssignmentEffect(transaction, scope, {
            selections: [],
            presetIds,
            builtinKeys: [],
          })
        )
      })

    it.effect("refuses a preset owned by a different exact scope", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay")
        yield* insertRelay("other-relay")
        const presets: Array<[string, ResourceScope]> = [
          ["same", scope],
          ["other-relay", { ...scope, relayId: "other-relay" }],
          ["other-server", { ...scope, resourceId: "other-server" }],
          ["database", { ...scope, resourceType: "database" }],
        ]
        for (const [id, presetScope] of presets) {
          yield* insertRows("permission_preset", {
            id,
            relay_id: presetScope.relayId,
            resource_type: presetScope.resourceType,
            resource_id: presetScope.resourceId,
            name: id,
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("preset_selection", {
            preset_id: id,
            selection_kind: "permission",
            selection_key: "instance.delete",
          })
        }

        expect(yield* resolvePresets(["same"])).toContain("instance.delete")
        for (const id of ["other-relay", "other-server", "database"]) {
          const error = yield* Effect.flip(resolvePresets(["same", id]))
          expect(error.message).toContain(
            "Presets must belong to this resource"
          )
        }
      })
    )
  })
})
