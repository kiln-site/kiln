import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser } from "@/test/seed"

import {
  addTunnelAliasEffect,
  generateTunnelNamesEffect,
  setGeneratedTunnelNamesEffect,
} from "./tunnel-names"

const tunnelId = "a".repeat(12)
const at = Date.UTC(2026, 0, 1)

afterAll(() => disposeAppRuntime())

const tunnel = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("owner")
  yield* insertRows("tunnel", {
    name: "Home",
    created_at: at,
    id: tunnelId,
    owner_id: "owner",
    updated_at: at,
  })
})

const member = (memberId: string, name: string) => ({
  fallback: `game-server-${memberId.slice(-6)}`,
  memberId,
  name,
})

describeMysql("A connected member's generated name", () => {
  layer(TestDatabase)((it) => {
    it.effect("is made once from what it's called", () =>
      Effect.gen(function* () {
        yield* tunnel
        const names = yield* generateTunnelNamesEffect(tunnelId, "kiln", [
          member("instance:aaaaaa111111", "Paper 26.3 — Survival!"),
          member("instance:bbbbbb222222", "  --Lobby   Hub--  "),
          member("instance:cccccc333333", "✨✨"),
          member("instance:dddddd444444", "x".repeat(80)),
        ])
        assert.strictEqual(
          names.get("instance:aaaaaa111111"),
          "paper-263-survival"
        )
        assert.strictEqual(names.get("instance:bbbbbb222222"), "lobby-hub")
        // Nothing is left of it, so it's named by its kind and ID.
        assert.strictEqual(
          names.get("instance:cccccc333333"),
          "game-server-333333"
        )
        assert.strictEqual(names.get("instance:dddddd444444"), "x".repeat(63))
      })
    )

    // A name is unique in its tunnel: another member's, an alias, or one
    // chosen in the same save keeps it, and the next free number is added.
    it.effect("takes the next number while the name is taken", () =>
      Effect.gen(function* () {
        yield* tunnel
        yield* setGeneratedTunnelNamesEffect(tunnelId, [
          {
            domain: "kiln",
            label: "survival",
            memberId: "instance:aaaaaa111111",
          },
        ])
        yield* addTunnelAliasEffect({
          domain: "kiln",
          label: "survival-2",
          memberId: "instance:aaaaaa111111",
          tunnelId,
        })
        // Under another TLD it's free.
        yield* addTunnelAliasEffect({
          domain: "test",
          label: "lobby",
          memberId: "instance:aaaaaa111111",
          tunnelId,
        })
        const names = yield* generateTunnelNamesEffect(
          tunnelId,
          "kiln",
          [
            member("instance:bbbbbb222222", "Survival"),
            member("instance:cccccc333333", "survival"),
            member("instance:dddddd444444", "Lobby"),
            member("instance:eeeeee555555", "Creative"),
            member("instance:ffffff666666", "y".repeat(70)),
            member("instance:999999777777", "y".repeat(70)),
          ],
          ["creative"]
        )
        assert.strictEqual(names.get("instance:bbbbbb222222"), "survival-3")
        assert.strictEqual(names.get("instance:cccccc333333"), "survival-4")
        assert.strictEqual(names.get("instance:dddddd444444"), "lobby")
        assert.strictEqual(names.get("instance:eeeeee555555"), "creative-2")
        assert.strictEqual(names.get("instance:ffffff666666"), "y".repeat(63))
        // Numbered, it still fits in a label.
        assert.strictEqual(
          names.get("instance:999999777777"),
          `${"y".repeat(61)}-2`
        )
      })
    )
  })
})
