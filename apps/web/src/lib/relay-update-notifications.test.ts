import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { listNotificationsEffect } from "@/effect/notifications"
import { recordRelayVersionEffect } from "@/lib/relay-update-notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, insertUser } from "@/test/seed"

const relay = { id: "relay-a", name: "Frankfurt" }

const seed = (version: string | null) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertUser("owner")
    yield* insertRelay(relay.id, {
      created_by: "owner",
      name: relay.name,
      node_version: version,
    })
  })

const inbox = Effect.map(listNotificationsEffect("owner"), (notifications) =>
  notifications.flatMap(({ content }) =>
    content.kind === "kiln.updated"
      ? [[content.previousVersion, content.version]]
      : []
  )
)

const relayResource = {
  id: relay.id,
  name: relay.name,
  relayId: relay.id,
  type: "relay",
} as const

describeMysql("Relay update notifications", () => {
  layer(TestDatabase)((it) => {
    it.effect("adds in a Relay update stored before they merged", () =>
      Effect.gen(function* () {
        yield* seed("1.0.0")
        yield* TestClock.setTime(1_000)
        yield* insertRows("notification", {
          created_at: 1_000,
          data: JSON.stringify({
            previousVersion: "0.9.0",
            resource: { ...relayResource, id: "relay-b", name: "Sydney" },
            version: "1.0.0",
          }),
          id: "11111111-1111-4111-8111-111111111111",
          kind: "relay.updated",
          source_key: "relay.updated:relay-b:1.0.0",
          user_id: "owner",
        })
        assert.deepStrictEqual(yield* inbox, [["0.9.0", "1.0.0"]])

        yield* TestClock.setTime(2_000)
        yield* recordRelayVersionEffect(relay.id, "1.1.0")
        assert.deepStrictEqual(yield* inbox, [["0.9.0", "1.1.0"]])
      })
    )
  })
})
