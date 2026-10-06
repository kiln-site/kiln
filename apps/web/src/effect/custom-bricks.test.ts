import { assert, layer } from "@effect/vitest"
import { builtinTailscaleBrick } from "@workspace/contracts"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  listCustomBricksEffect,
  saveCustomBrickEffect,
} from "@/effect/custom-bricks"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, selectRows } from "@/test/seed"

const now = Date.UTC(2026, 8, 1)

const newerBrick = {
  ...builtinTailscaleBrick,
  metadata: {
    ...builtinTailscaleBrick.metadata,
    id: "custom-networking",
    name: "Custom Networking",
  },
  source: "https://example.com/custom-networking.yml",
}

const insertRecipe = (id: string, recipe: string, updatedAt: number) =>
  insertRows("custom_brick", {
    id,
    owner_user_id: "user-one",
    source_hash: id.padEnd(64, "0"),
    source: `https://example.com/${id}.yml`,
    recipe,
    created_at: updatedAt,
    updated_at: updatedAt,
  })

describeMysql("custom Brick persistence", () => {
  layer(TestDatabase)((it) => {
    it.effect("replaces an owner's recipe for the same source", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* TestClock.setTime(now)
        yield* saveCustomBrickEffect("user-one", builtinTailscaleBrick)
        yield* saveCustomBrickEffect("user-two", builtinTailscaleBrick)

        const renamed = {
          ...builtinTailscaleBrick,
          metadata: { ...builtinTailscaleBrick.metadata, name: "Renamed" },
        }
        yield* TestClock.adjust(1_000)
        const saved = yield* saveCustomBrickEffect("user-one", renamed)

        assert.deepEqual(saved, renamed)
        assert.deepEqual(yield* listCustomBricksEffect("user-one"), [renamed])
        assert.deepEqual(yield* listCustomBricksEffect("user-two"), [
          builtinTailscaleBrick,
        ])
        assert.lengthOf(yield* selectRows("custom_brick"), 2)
      })
    )

    it.effect("lists newest first and skips invalid recipes", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* TestClock.setTime(now)
        yield* saveCustomBrickEffect("user-one", builtinTailscaleBrick)
        yield* TestClock.adjust(3_000)
        yield* saveCustomBrickEffect("user-one", newerBrick)
        yield* insertRecipe("not-json", JSON.stringify("not-json"), now + 1_000)
        yield* insertRecipe(
          "incomplete",
          JSON.stringify({ metadata: { name: "Incomplete" } }),
          now + 2_000
        )
        yield* saveCustomBrickEffect("user-two", {
          ...newerBrick,
          source: "https://example.com/foreign.yml",
        })

        const bricks = yield* listCustomBricksEffect("user-one")

        assert.deepEqual(bricks, [newerBrick, builtinTailscaleBrick])
      })
    )
  })
})
