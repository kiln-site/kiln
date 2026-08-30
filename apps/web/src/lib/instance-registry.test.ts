import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader } from "mysql2/promise"

import { Database } from "@/effect/database"
import {
  registerInstanceEffect,
  reservePreparedInstanceEffect,
  syncInstanceRegistryEffect,
} from "@/lib/instance-registry"

const emptyResult: ResultSetHeader = {
  affectedRows: 0,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

describe("instance registry sync", () => {
  it.effect("registers a newly created instance immediately", () => {
    const statements: Array<{
      sql: string
      values: ReadonlyArray<unknown>
    }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: (_operation, sql, values) =>
        Effect.sync(() => {
          statements.push({ sql, values: values ?? [] })
          return emptyResult
        }),
      queryRows: () => Effect.die("Unexpected database query"),
      transaction: () => Effect.die("Unexpected transaction"),
    })

    return Effect.gen(function* () {
      yield* registerInstanceEffect(
        "relay-one",
        { id: "instance-one" },
        "user-one"
      )

      assert.lengthOf(statements, 1)
      assert.include(statements[0]?.sql ?? "", "owner_id")
      assert.deepEqual(statements[0]?.values, [
        "relay-one",
        "instance-one",
        "user-one",
      ])
    }).pipe(Effect.provide(databaseLayer))
  })

  it.effect(
    "protects a prepared owner reservation from snapshot pruning",
    () => {
      const statements: Array<{
        sql: string
        values: ReadonlyArray<unknown>
      }> = []
      const databaseLayer = Layer.succeed(Database)({
        execute: (_operation, sql, values) =>
          Effect.sync(() => {
            statements.push({ sql, values: values ?? [] })
            return emptyResult
          }),
        queryRows: () => Effect.die("Unexpected database query"),
        transaction: () => Effect.die("Unexpected transaction"),
      })

      return Effect.gen(function* () {
        yield* reservePreparedInstanceEffect(
          "relay-one",
          { id: "instance-one" },
          "user-one"
        )

        assert.include(statements[0]?.sql ?? "", "provisioning_reserved_until")
        assert.include(statements[0]?.sql ?? "", "INTERVAL 2 MINUTE")
      }).pipe(Effect.provide(databaseLayer))
    }
  )

  it.effect("stores Relay names outside the unique display-name key", () => {
    const statements: Array<{
      sql: string
      values: ReadonlyArray<unknown>
    }> = []
    const databaseLayer = Layer.succeed(Database)({
      execute: () => Effect.die("Unexpected standalone database write"),
      queryRows: () => Effect.die("Unexpected database query"),
      transaction: (_operation, run) =>
        run({
          execute: (sql, values) =>
            Effect.sync(() => {
              statements.push({ sql, values: values ?? [] })
              return emptyResult
            }),
          queryRows: () => Effect.die("Unexpected transaction query"),
        }),
    })

    return Effect.gen(function* () {
      yield* syncInstanceRegistryEffect("relay-one", [
        { id: "instance-one", name: "Survival" },
        { id: "instance-two", name: "Survival" },
      ])

      const insert = statements[0]
      assert.isDefined(insert)
      assert.include(insert.sql, "display_name, source_name")
      assert.include(insert.sql, "(?, ?, NULL, ?), (?, ?, NULL, ?)")
      assert.notInclude(insert.sql, "display_name = VALUES(display_name)")
      assert.include(insert.sql, "source_name = VALUES(source_name)")
      const prune = statements[1]
      assert.isDefined(prune)
      assert.include(prune.sql, "provisioning_reserved_until")
      assert.deepEqual(insert.values, [
        "relay-one",
        "instance-one",
        "Survival",
        "relay-one",
        "instance-two",
        "Survival",
      ])
    }).pipe(Effect.provide(databaseLayer))
  })
})
