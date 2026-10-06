import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"

import { databaseTableName } from "@/lib/database-config"
import { grantHasPermission } from "@/lib/permissions"
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

const insertDatabase = (id: string, engine: string) =>
  insertRows("database", {
    database_id: id,
    relay_id: "relay",
    name: id,
    engine,
    database_name: id,
    username: id,
    password_ciphertext: "ciphertext",
    created_by: "someone",
    created_at: 0,
    updated_at: 0,
  })

describeMysql("effective resource authority", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps an explicitly empty grant empty even when its legacy role was admin",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay")
          yield* insertGrant({
            id: "empty",
            userId: "user",
            relayId: "relay",
            resourceType: "instance",
            resourceId: "server",
            role: "admin",
          })

          const grants = yield* loadResourceGrantsEffect("user", "relay")

          expect(grants).toHaveLength(1)
          expect(grants[0]?.permissions).toEqual([])
          expect(grantHasPermission(grants[0]!, "instance.files.read")).toBe(
            false
          )
          expect(effectiveScopePermissions(grants, scope).size).toBe(0)
        })
    )

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

    it.effect(
      "filters unsupported Redis and Valkey dump authority from explicit and preset ALL grants",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay")
          for (const engine of ["redis", "valkey", "postgres"]) {
            yield* insertDatabase(engine, engine)
            yield* insertGrant({
              id: engine,
              userId: "user",
              relayId: "relay",
              resourceType: "database",
              resourceId: engine,
            })
          }
          yield* select("redis", "database.dump.export")
          yield* select("redis", "database.read")
          yield* insertPreset(
            "valkey-all",
            {
              relayId: "relay",
              resourceType: "database",
              resourceId: "valkey",
            },
            ["all"],
            "collection"
          )
          yield* assignPreset("valkey", "valkey-all")
          yield* select("postgres", "database.dump.export")

          const grants = yield* loadResourceGrantsEffect("user", "relay")

          for (const id of ["redis", "valkey"]) {
            const grant = grants.find((grant) => grant.id === id)
            expect(grant?.permissions).toContain("database.read")
            expect(grant?.permissions).not.toContain("database.dump.export")
            expect(grant?.permissions).not.toContain("database.dump.import")
          }
          expect(
            grants.find((grant) => grant.id === "postgres")?.permissions
          ).toContain("database.dump.export")
        })
    )

    it.effect(
      "deduplicates permissions shared by many live presets before validation",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay("relay")
          yield* insertGrant({
            id: "access",
            userId: "user",
            relayId: "relay",
            resourceType: "instance",
            resourceId: "server",
          })
          yield* select("access", "instance.files.read")
          // More selections than one validated assignment may hold.
          const presetIds = Array.from({ length: 300 }, (_, i) => `preset-${i}`)
          yield* insertRows(
            "permission_preset",
            presetIds.map((id) => ({
              id,
              relay_id: "relay",
              resource_type: "instance",
              resource_id: "server",
              name: id,
              created_at: 0,
              updated_at: 0,
            }))
          )
          yield* insertRows(
            "preset_selection",
            presetIds.map((id) => ({
              preset_id: id,
              selection_kind: "permission",
              selection_key: "instance.files.read",
            }))
          )
          yield* insertRows(
            "access_preset",
            presetIds.map((id) => ({
              id,
              access_id: "access",
              preset_id: id,
              created_at: 0,
            }))
          )

          const grants = yield* loadResourceGrantsEffect("user", "relay")

          expect(
            grants[0]?.permissions.filter(
              (permission) => permission === "instance.files.read"
            )
          ).toHaveLength(1)
        })
    )
  })
})
