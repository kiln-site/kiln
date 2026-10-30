import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { databaseTableName } from "@/lib/database-config"
import {
  effectiveScopePermissions,
  loadResourceGrantsEffect,
  type ResourceScope,
} from "@/lib/resource-permissions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
} from "@/test/seed"

const scope: ResourceScope = {
  relayId: "relay",
  resourceType: "instance",
  resourceId: "server",
}

const select = (accessId: string, key: string, kind = "permission") =>
  insertRows("access_selection", {
    access_id: accessId,
    selection_kind: kind,
    selection_key: key,
  })

const insertPreset = (
  id: string,
  target: ResourceScope,
  keys: ReadonlyArray<string>,
  kind = "permission"
) =>
  Effect.gen(function* () {
    yield* insertRows("permission_preset", {
      id,
      relay_id: target.relayId,
      resource_type: target.resourceType,
      resource_id: target.resourceId,
      name: id,
      created_at: 0,
      updated_at: 0,
    })
    if (keys.length)
      yield* insertRows(
        "preset_selection",
        keys.map((key) => ({
          preset_id: id,
          selection_kind: kind,
          selection_key: key,
        }))
      )
  })

const assignPreset = (accessId: string, presetId: string) =>
  insertRows("access_preset", {
    id: `${accessId}:${presetId}`.slice(0, 36),
    access_id: accessId,
    preset_id: presetId,
    created_at: 0,
  })

describeMysql("effective resource authority", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "unions live preset selections with Relay inheritance and only the matching child scope",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay")
          for (const [id, resourceType, resourceId] of [
            ["relay-access", "relay", "relay"],
            ["server-access", "instance", "server"],
            ["other-access", "instance", "other"],
          ] as const) {
            yield* insertGrant({
              id,
              userId: "user",
              relayId: "relay",
              resourceType,
              resourceId,
            })
          }
          yield* select("relay-access", "instance.files.read")
          yield* insertPreset("server-preset", scope, ["instance.console.read"])
          yield* assignPreset("server-access", "server-preset")
          yield* select("other-access", "instance.delete")

          const first = effectiveScopePermissions(
            yield* loadResourceGrantsEffect("user", "relay"),
            scope
          )
          expect(first.has("instance.files.read")).toBe(true)
          expect(first.has("instance.console.read")).toBe(true)
          expect(first.has("instance.delete")).toBe(false)

          // A preset edit is observed on the next authorization read without
          // touching the membership rows.
          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM ${sql(databaseTableName("preset_selection"))} WHERE preset_id = 'server-preset'`
          yield* insertRows("preset_selection", {
            preset_id: "server-preset",
            selection_kind: "permission",
            selection_key: "instance.files.write",
          })

          const next = effectiveScopePermissions(
            yield* loadResourceGrantsEffect("user", "relay"),
            scope
          )
          expect(next.has("instance.console.read")).toBe(false)
          expect(next.has("instance.files.write")).toBe(true)
        })
    )

    it.effect(
      "ignores a preset that belongs to a different scope than its grant",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay")
          yield* insertGrant({
            id: "server-access",
            userId: "user",
            relayId: "relay",
            resourceType: "instance",
            resourceId: "server",
          })
          yield* insertPreset(
            "other-preset",
            { ...scope, resourceId: "other" },
            ["instance.delete"]
          )
          yield* assignPreset("server-access", "other-preset")

          const grants = yield* loadResourceGrantsEffect("user", "relay")
          expect(effectiveScopePermissions(grants, scope).size).toBe(0)
        })
    )

    it.effect(
      "preserves owner authority without an access assignment and loads only active assignments",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay")
          yield* insertInstance("relay", "server", { owner_id: "owner" })
          yield* insertInstance("relay", "other")
          // Inactive assignments, one of them Relay-wide, grant nothing.
          for (const [state, resourceType, resourceId] of [
            ["pending", "instance", "other"],
            ["revoked", "relay", "relay"],
          ] as const) {
            yield* insertGrant({
              id: `${state}-access`,
              userId: "owner",
              relayId: "relay",
              resourceType,
              resourceId,
              state,
            })
            yield* select(`${state}-access`, "all", "collection")
          }

          const grants = yield* loadResourceGrantsEffect("owner", "relay")

          expect(grants.map((grant) => grant.source)).toEqual(["owner"])
          expect(
            effectiveScopePermissions(grants, scope).has("instance.delete")
          ).toBe(true)
          expect(
            effectiveScopePermissions(grants, { ...scope, resourceId: "other" })
              .size
          ).toBe(0)
        })
    )
  })
})
