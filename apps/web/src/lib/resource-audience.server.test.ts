import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { saveNotificationPreferencesEffect } from "@/effect/notification-preferences"
import { notificationAudienceEffect } from "@/lib/resource-audience.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

const relayId = "relay-a"
const scope = {
  relayId,
  resourceId: "server-a",
  resourceType: "instance",
} as const

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("owner")
  yield* insertUser("granted")
  yield* insertUser("admin", { role: "admin" })
  yield* insertRelay(relayId)
  yield* insertInstance(relayId, "server-a", { owner_id: "owner" })
  yield* insertGrant({
    id: "11111111-1111-4111-8111-111111111111",
    relayId,
    resourceId: "server-a",
    resourceType: "instance",
    userId: "granted",
  })
  yield* insertRows("access_selection", {
    access_id: "11111111-1111-4111-8111-111111111111",
    selection_key: "instance.configuration.write",
    selection_kind: "permission",
  })
})

const audience = notificationAudienceEffect(
  scope,
  "instance.configuration.write",
  "security.report"
).pipe(Effect.map((ids) => [...ids].sort()))

const chooseEveryone = (choice: "all" | "own" | "shared") =>
  Effect.forEach(["admin", "granted", "owner"], (userId) =>
    saveNotificationPreferencesEffect(userId, { scope: choice })
  )

describeMysql("notification audience", () => {
  layer(TestDatabase)((it) => {
    it.effect("reaches everyone who can act by default", () =>
      Effect.gen(function* () {
        yield* seed
        assert.deepStrictEqual(yield* audience, ["admin", "granted", "owner"])
      })
    )

    it.effect("leaves out what only a platform role reaches", () =>
      Effect.gen(function* () {
        yield* seed
        yield* chooseEveryone("shared")
        assert.deepStrictEqual(yield* audience, ["granted", "owner"])
      })
    )

    it.effect("narrows to what the person owns", () =>
      Effect.gen(function* () {
        yield* seed
        yield* chooseEveryone("own")
        assert.deepStrictEqual(yield* audience, ["owner"])
      })
    )

    it.effect("drops someone who turned this resource off", () =>
      Effect.gen(function* () {
        yield* seed
        yield* saveNotificationPreferencesEffect("granted", {
          resources: {
            [`instance:${relayId}:server-a`]: {
              kinds: { "security.report": false },
              name: "Survival",
              type: "instance",
            },
          },
        })
        assert.deepStrictEqual(yield* audience, ["admin", "owner"])
      })
    )
  })
})
