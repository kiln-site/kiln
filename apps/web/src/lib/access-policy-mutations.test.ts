import { describe, expect, it, layer } from "@effect/vitest"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import {
  assertDelegation,
  copyInstanceAccessEffect,
  resolveAssignmentEffect,
} from "@/lib/access-policy-mutations"
import type { ResourceScope } from "@/lib/resource-permissions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

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

describeMysql("copying a server's access", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "gives the copy the same people and permissions, and no one else",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay")
          yield* insertRelay("other-relay")
          for (const id of [
            "actor",
            "member",
            "copy-owner",
            "invited",
            "admin",
          ]) {
            yield* insertUser(id)
          }
          yield* insertInstance("relay", "source")
          yield* insertInstance("other-relay", "copy", {
            owner_id: "copy-owner",
          })
          yield* insertRows("permission_preset", {
            id: "source-preset",
            relay_id: "relay",
            resource_type: "instance",
            resource_id: "source",
            name: "Moderators",
            created_at: 0,
            updated_at: 0,
          })
          yield* insertRows("preset_selection", {
            preset_id: "source-preset",
            selection_kind: "permission",
            selection_key: "instance.console.write",
          })
          const member = "member-grant"
          yield* insertGrant({
            id: member,
            relayId: "relay",
            resourceId: "source",
            resourceType: "instance",
            userId: "member",
          })
          yield* insertRows("access_selection", {
            access_id: member,
            selection_kind: "permission",
            selection_key: "instance.files.read",
          })
          yield* insertRows("access_preset", {
            id: "member-preset",
            access_id: member,
            preset_id: "source-preset",
            created_at: 0,
          })
          // The copy's owner owns it rather than being granted access.
          yield* insertGrant({
            relayId: "relay",
            resourceId: "source",
            resourceType: "instance",
            userId: "copy-owner",
          })
          // An unanswered invitation's link can't be copied.
          yield* insertGrant({
            relayId: "relay",
            resourceId: "source",
            resourceType: "instance",
            state: "pending",
            userId: "invited",
          })
          // Access to the source's Relay doesn't reach another Relay.
          yield* insertGrant({
            relayId: "relay",
            resourceId: "relay",
            resourceType: "relay",
            userId: "admin",
          })

          const copied = yield* copyInstanceAccessEffect({
            actorId: "actor",
            from: { instanceId: "source", relayId: "relay" },
            to: { instanceId: "copy", relayId: "other-relay" },
          })

          expect(copied).toEqual(["member"])
          const grants = (yield* selectRows<{
            id: string
            relay_id: string
            resource_id: string
            user_id: string
          }>("access_grant")).filter(
            (grant) =>
              grant.relay_id === "other-relay" && grant.resource_id === "copy"
          )
          expect(grants.map((grant) => grant.user_id)).toEqual(["member"])
          const grantId = grants[0]!.id
          const selections = yield* selectRows<{
            access_id: string
            selection_key: string
          }>("access_selection")
          expect(
            selections
              .filter((selection) => selection.access_id === grantId)
              .map((selection) => selection.selection_key)
          ).toEqual(["instance.files.read"])
          const assigned = (yield* selectRows<{
            access_id: string
            preset_id: string
          }>("access_preset")).find((row) => row.access_id === grantId)
          const preset = (yield* selectRows<{
            id: string
            resource_id: string
          }>("permission_preset")).find((row) => row.id === assigned?.preset_id)
          const presetSelections = (yield* selectRows<{
            preset_id: string
            selection_key: string
          }>("preset_selection")).filter((row) => row.preset_id === preset?.id)
          // The preset is copied to the copy, never shared with the source.
          expect(preset?.resource_id).toBe("copy")
          expect(presetSelections.map((row) => row.selection_key)).toEqual([
            "instance.console.write",
          ])
          expect(preset?.id).not.toBe("source-preset")
        })
    )
  })
})
