import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { readInfraRelayOptions } from "@/server/infra-directory.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

const user: AuthenticatedUser = {
  id: "infra-reader",
  name: "Reader",
  email: "infra@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  isDevelopmentBypass: false,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}

describeMysql("infra directory visibility", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "a scoped database reader sees its Relay without acquiring creation or App access",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser(user.id)
          const relayId = "r".repeat(43)
          yield* insertRelay(relayId)
          yield* insertRelay("s".repeat(43))
          yield* insertGrant({
            id: "scoped-reader",
            userId: user.id,
            relayId,
            resourceType: "database",
            resourceId: "a".repeat(40),
          })
          yield* insertRows("access_selection", {
            access_id: "scoped-reader",
            selection_kind: "permission",
            selection_key: "database.read",
          })
          const databases = yield* readInfraRelayOptions(user, "database")
          const apps = yield* readInfraRelayOptions(user, "app")
          assert.deepStrictEqual(
            databases.relays.map(({ id, canCreate }) => ({ id, canCreate })),
            [{ id: relayId, canCreate: false }]
          )
          assert.deepStrictEqual(apps.relays, [])
          assert.deepStrictEqual(
            Object.keys(databases.relays[0]!).sort((left, right) =>
              left.localeCompare(right)
            ),
            ["canCreate", "id", "name"]
          )
        })
    )
  })
})
