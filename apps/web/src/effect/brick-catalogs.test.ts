import { assert, layer } from "@effect/vitest"
import type { RelayCatalog } from "@workspace/contracts"
import { Effect, Result } from "effect"
import { TestClock } from "effect/testing"

import {
  PERSONAL_CATALOG_LIMIT,
  listBrickCatalogsEffect,
  saveBrickCatalogEffect,
} from "@/effect/brick-catalogs"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser, selectRows } from "@/test/seed"

const now = Date.UTC(2026, 8, 29)

const snapshot: RelayCatalog = {
  bricks: [],
  format: "kiln.catalog/v1",
}

const save = (source: string) =>
  saveBrickCatalogEffect({
    ownerUserId: "user-one",
    revisionSha: null,
    revisionUrl: null,
    snapshot,
    snapshotSha256: "a".repeat(64),
    source,
  })

const insertCatalog = (id: string, row: Record<string, string | number>) =>
  insertRows("brick_catalog", {
    id,
    owner_user_id: "user-one",
    source_hash: id.padEnd(64, "0"),
    source: `https://example.com/${id}.yml`,
    snapshot: JSON.stringify(snapshot),
    snapshot_sha256: "b".repeat(64),
    created_at: now,
    updated_at: now,
    ...row,
  })

describeMysql("Brick catalog persistence", () => {
  layer(TestDatabase)((it) => {
    it.effect("holds the personal limit when saves race", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* TestClock.setTime(now)
        yield* insertUser("user-one")
        for (let index = 1; index < PERSONAL_CATALOG_LIMIT; index++) {
          yield* save(`https://example.com/catalog-${index}.yml`)
        }

        const results = yield* Effect.all(
          [
            Effect.result(save("https://example.com/racer-a.yml")),
            Effect.result(save("https://example.com/racer-b.yml")),
          ],
          { concurrency: "unbounded" }
        )

        assert.strictEqual(results.filter(Result.isSuccess).length, 1)
        assert.lengthOf(
          yield* selectRows("brick_catalog"),
          PERSONAL_CATALOG_LIMIT
        )
      })
    )

    it.effect("updates an existing source at the limit", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* TestClock.setTime(now)
        const ids: Array<string> = []
        for (let index = 0; index < PERSONAL_CATALOG_LIMIT; index++) {
          ids.push(yield* save(`https://example.com/catalog-${index}.yml`))
        }

        const extra = yield* Effect.result(save("https://example.com/new.yml"))
        const resaved = yield* save("https://example.com/catalog-0.yml")

        assert.isTrue(Result.isFailure(extra))
        assert.strictEqual(resaved, ids[0])
        assert.lengthOf(
          yield* selectRows("brick_catalog"),
          PERSONAL_CATALOG_LIMIT
        )
      })
    )

    it.effect("lists an invalid stored snapshot without failing", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertCatalog("valid-catalog", {})
        yield* insertCatalog("invalid-catalog", {
          snapshot: JSON.stringify({ format: "unknown" }),
        })

        const records = yield* listBrickCatalogsEffect("user-one", false)

        const byId = new Map(records.map((record) => [record.id, record]))
        assert.deepEqual(byId.get("valid-catalog")?.snapshot, snapshot)
        assert.isNull(byId.get("valid-catalog")?.statusError)
        assert.isNull(byId.get("invalid-catalog")?.snapshot)
        assert.isNotNull(byId.get("invalid-catalog")?.statusError)
      })
    )
  })
})
