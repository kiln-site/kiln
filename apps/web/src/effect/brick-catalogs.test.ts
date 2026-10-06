import { assert, describe, layer } from "@effect/vitest"
import type { RelayCatalog } from "@workspace/contracts"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"

import {
  listBrickCatalogsEffect,
  saveBrickCatalogEffect,
} from "@/effect/brick-catalogs"
import { Database } from "@/effect/database"

const emptyResult: ResultSetHeader = {
  affectedRows: 1,
  changedRows: 0,
  constructor: { name: "ResultSetHeader" },
  fieldCount: 0,
  info: "",
  insertId: 0,
  serverStatus: 0,
  warningStatus: 0,
}

const snapshot: RelayCatalog = {
  bricks: [],
  format: "kiln.catalog/v1",
}

describe("Brick catalog persistence", () => {
  const transactionQueries: Array<string> = []
  const databaseLayer = Layer.succeed(Database)({
    execute: () => Effect.succeed(emptyResult),
    queryRows: <TRow extends RowDataPacket>() =>
      Effect.succeed([] as unknown as ReadonlyArray<TRow>),
    transaction: (_operation, run) =>
      run({
        execute: () => Effect.succeed(emptyResult),
        queryRows: <TRow extends RowDataPacket>(sql: string) =>
          Effect.sync(() => {
            transactionQueries.push(sql)
            if (sql.includes("SELECT id FROM") && sql.includes("user")) {
              return [{ id: "user-one" }] as unknown as ReadonlyArray<TRow>
            }
            if (sql.includes("COUNT(*)")) {
              return [{ total: 0 }] as unknown as ReadonlyArray<TRow>
            }
            return [] as unknown as ReadonlyArray<TRow>
          }),
      }),
  })

  layer(databaseLayer)((it) => {
    it.effect("locks the owner before enforcing the personal limit", () =>
      Effect.gen(function* () {
        transactionQueries.length = 0

        yield* saveBrickCatalogEffect({
          ownerUserId: "user-one",
          revisionSha: null,
          revisionUrl: null,
          snapshot,
          snapshotSha256: "a".repeat(64),
          source: "https://example.com/catalog.yml",
        })

        assert.include(transactionQueries[0] ?? "", "FOR UPDATE")
        assert.include(transactionQueries[0] ?? "", "user")
        assert.isBelow(
          transactionQueries.findIndex((sql) => sql.includes("user")),
          transactionQueries.findIndex((sql) => sql.includes("COUNT(*)"))
        )
      })
    )
  })

  layer(
    Layer.succeed(Database)({
      execute: () => Effect.succeed(emptyResult),
      queryRows: <TRow extends RowDataPacket>() =>
        Effect.succeed([
          {
            id: "invalid-catalog",
            owner_email: null,
            owner_name: null,
            owner_user_id: "user-one",
            published_at: null,
            published_by: null,
            revision_sha: null,
            revision_url: null,
            snapshot: "not-json",
            snapshot_sha256: "b".repeat(64),
            source: "https://example.com/catalog.yml",
            updated_at: Date.UTC(2026, 8, 29),
            visibility: "personal",
          },
        ] as unknown as ReadonlyArray<TRow>),
      transaction: () => Effect.die("Unexpected database transaction"),
    })
  )((it) => {
    it.effect("surfaces an invalid snapshot without failing the listing", () =>
      Effect.gen(function* () {
        const records = yield* listBrickCatalogsEffect("user-one", false)
        assert.strictEqual(records.length, 1)
        assert.isNull(records[0]?.snapshot)
        assert.strictEqual(
          records[0]?.statusError,
          "Stored catalog snapshot is invalid"
        )
      })
    )
  })
})
