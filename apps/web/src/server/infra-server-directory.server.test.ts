import { assert, layer } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { builtinTailscaleBrickId } from "@workspace/contracts"

import { AppCache } from "@/effect/cache"
import type { DirectoryInstance } from "@/lib/instance-directory"
import { registerPreparedInstanceEffect } from "@/lib/instance-registry"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { readInfraServerDirectory } from "@/server/infra-directory.server"
import { finalizeInstanceDeletionEffect } from "@/server/instance-deletion-cleanup"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

const relayId = "r".repeat(43),
  id = "a".repeat(40)
const user: AuthenticatedUser = {
  id: "server-reader",
  name: "Reader",
  email: "reader@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}
const server = (id: string): DirectoryInstance => ({
  id,
  name: "Survival",
  brickId: "minecraft-paper",
  game: "Minecraft",
  implementation: "Paper",
  version: "1.21",
  connectAddress: "play.example.test:25565",
  tailscale: { enabled: false },
})

const disabledCache = Layer.succeed(AppCache)({
  backend: "disabled",
  enabled: false,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
})

describeMysql("Game Server directory", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "returns offline metadata only for the granted instance on its Relay",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser(user.id)
          yield* insertRelay(relayId)
          yield* insertRelay("s".repeat(43))
          yield* registerPreparedInstanceEffect(relayId, server(id), "owner")
          yield* registerPreparedInstanceEffect(
            relayId,
            server("b".repeat(40)),
            "owner"
          )
          yield* registerPreparedInstanceEffect(
            "s".repeat(43),
            server(id),
            "owner"
          )
          yield* insertGrant({
            id: "read-one",
            userId: user.id,
            relayId,
            resourceType: "instance",
            resourceId: id,
          })
          yield* insertRows("access_selection", {
            access_id: "read-one",
            selection_kind: "permission",
            selection_key: "instance.read",
          })
          const rows = yield* readInfraServerDirectory(user).pipe(
            Effect.provide(disabledCache)
          )
          assert.strictEqual(rows.length, 1)
          assert.strictEqual(rows[0]?.id, id)
          assert.strictEqual(rows[0]?.relayId, relayId)
          assert.strictEqual(rows[0]?.game, "Minecraft")
          assert.strictEqual(rows[0]?.connectAddress, "play.example.test:25565")
        })
    )

    it.effect(
      "keeps local names while hiding unreported records, networking instances, and paused Relays",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertRelay("s".repeat(43), { enabled: false })
          yield* insertInstance(relayId, id, {
            display_name: "Lobby",
            source_name: "Old name",
          })
          yield* registerPreparedInstanceEffect(relayId, server(id), "owner")
          yield* insertInstance(relayId, "b".repeat(40), {
            source_name: "Legacy",
          })
          yield* registerPreparedInstanceEffect(
            relayId,
            { ...server("c".repeat(40)), brickId: builtinTailscaleBrickId },
            "owner"
          )
          yield* registerPreparedInstanceEffect(
            "s".repeat(43),
            server(id),
            "owner"
          )
          const rows = yield* readInfraServerDirectory({
            ...user,
            isDevelopmentBypass: true,
          }).pipe(Effect.provide(disabledCache))
          // A record no Relay has described yet cannot be told apart from a
          // networking stack, so it waits for its first snapshot.
          assert.deepStrictEqual(
            rows.map((row) => row.name),
            ["Lobby"]
          )
        })
    )

    it.effect("drops a game server once its deletion is finalized", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayId)
        yield* registerPreparedInstanceEffect(relayId, server(id), "owner")
        yield* registerPreparedInstanceEffect(
          relayId,
          server("b".repeat(40)),
          "owner"
        )
        const admin = { ...user, isDevelopmentBypass: true }
        yield* finalizeInstanceDeletionEffect(relayId, id).pipe(
          Effect.provide(disabledCache)
        )
        const rows = yield* readInfraServerDirectory(admin).pipe(
          Effect.provide(disabledCache)
        )
        assert.deepStrictEqual(
          rows.map((row) => row.id),
          ["b".repeat(40)]
        )
      })
    )
  })
})
