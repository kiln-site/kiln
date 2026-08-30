import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"

import { listBackupCatalogPageEffect } from "@/effect/backups"
import { Database } from "@/effect/database"

describe("backup runs page query", () => {
  it.effect(
    "applies authorization and escaped search before the page limit",
    () => {
      const queries: Array<{
        operation: string
        sql: string
        values: ReadonlyArray<unknown>
      }> = []
      const databaseLayer = Layer.succeed(Database)({
        execute: () => Effect.die("Unexpected database write"),
        queryRows: (operation, sql, values) =>
          Effect.sync(() => {
            queries.push({ operation, sql, values: values ?? [] })
            return []
          }),
        transaction: () => Effect.die("Unexpected transaction"),
      })

      return Effect.gen(function* () {
        const page = yield* listBackupCatalogPageEffect({
          allowedRoles: ["viewer"],
          cursor: null,
          direction: "desc",
          isAdmin: false,
          limit: 50,
          scope: null,
          search: "100%_safe",
          sort: "createdAt",
          status: "available",
          userId: "user-a",
        })

        assert.deepEqual(page, { hasMore: false, items: [] })
        assert.lengthOf(queries, 1)
        const query = queries[0]
        assert.isDefined(query)
        assert.equal(query.operation, "backup_catalog_page")
        assert.include(query.sql, "access_grant.user_id = ?")
        assert.include(query.sql, "backup.created_by = ?")
        assert.include(query.sql, "backup.status = 'available'")
        assert.include(query.sql, "LIMIT ?")
        assert.isBelow(
          query.sql.indexOf("access_grant"),
          query.sql.indexOf("LIMIT ?")
        )
        assert.equal(query.values.at(-1), 51)
        assert.include(query.values, "%100\\%\\_safe%")
      }).pipe(Effect.provide(databaseLayer))
    }
  )

  it.effect("builds stable keyset predicates for every sort direction", () => {
    const queries: Array<{
      operation: string
      sql: string
      values: ReadonlyArray<unknown>
    }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected database write"),
      queryRows: (operation, sql, values) =>
        Effect.sync(() => {
          queries.push({ operation, sql, values: values ?? [] })
          return []
        }),
      transaction: () => Effect.die("Unexpected transaction"),
    })
    const cursorId = "7ff61850-2e5e-4238-b960-755b743a246a"
    const cases = [
      {
        order: "backup.created_at",
        sort: "createdAt",
        value: 1_767_225_600_000,
      },
      {
        order: "LOWER(backup.name) COLLATE utf8mb4_bin",
        sort: "name",
        value: "backup-a",
      },
      { order: "CASE backup.target_kind", sort: "target", value: "server-a" },
      { order: "backup.bytes", sort: "size", value: 1_024 },
    ] as const

    return Effect.gen(function* () {
      for (const direction of ["asc", "desc"] as const) {
        for (const testCase of cases) {
          yield* listBackupCatalogPageEffect({
            allowedRoles: [],
            cursor: { id: cursorId, value: testCase.value },
            direction,
            isAdmin: true,
            limit: 50,
            scope: null,
            search: "",
            sort: testCase.sort,
            status: null,
            userId: "admin-a",
          })

          const query = queries.at(-1)
          assert.isDefined(query)
          const sql = query.sql.replace(/\s+/gu, " ")
          const operator = direction === "asc" ? ">" : "<"
          assert.equal(query.operation, "backup_catalog_page")
          assert.include(sql, testCase.order)
          assert.include(sql, `${operator} ?`)
          assert.include(sql, `backup.id ${operator} ?`)
          assert.include(sql, `backup.id ${direction.toUpperCase()}`)
          if (testCase.sort === "size") {
            assert.include(sql, "IS NULL ASC")
            assert.include(sql, "OR (CASE")
            assert.include(sql, "IS NULL)")
          }
          assert.deepEqual(query.values.slice(-4), [
            testCase.value,
            testCase.value,
            cursorId,
            51,
          ])
          assert.lengthOf(query.values, sql.match(/\?/gu)?.length ?? 0)
        }

        yield* listBackupCatalogPageEffect({
          allowedRoles: [],
          cursor: { id: cursorId, value: null },
          direction,
          isAdmin: true,
          limit: 50,
          scope: null,
          search: "",
          sort: "size",
          status: null,
          userId: "admin-a",
        })
        const nullSizeQuery = queries.at(-1)
        assert.isDefined(nullSizeQuery)
        const sql = nullSizeQuery.sql.replace(/\s+/gu, " ")
        const operator = direction === "asc" ? ">" : "<"
        assert.include(sql, `IS NULL AND backup.id ${operator} ?`)
        assert.include(sql, "IS NULL ASC")
        assert.deepEqual(nullSizeQuery.values, [cursorId, 51])
        assert.lengthOf(nullSizeQuery.values, sql.match(/\?/gu)?.length ?? 0)
      }
    }).pipe(Effect.provide(databaseLayer))
  })
})
