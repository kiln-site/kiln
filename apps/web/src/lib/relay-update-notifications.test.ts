import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import {
  listNotificationsEffect,
  markNotificationsReadEffect,
  notifyUsersEffect,
} from "@/effect/notifications"
import {
  recordConnectedRelayVersionEffect,
  recordRelayVersionEffect,
} from "@/lib/relay-update-notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, insertUser, selectRows } from "@/test/seed"

const connected = vi.hoisted(() => ({ version: null as string | null }))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionNode: () =>
    connected.version === null ? null : { version: connected.version },
}))

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

const recorded = Effect.map(
  selectRows<{ node_version: string | null }>("relay"),
  ([row]) => row?.node_version
)

describeMysql("Relay update notifications", () => {
  layer(TestDatabase)((it) => {
    it.effect("tells those who can update a Relay it was updated", () =>
      Effect.gen(function* () {
        yield* seed("1.0.0")
        yield* recordRelayVersionEffect(relay.id, "1.1.0")
        assert.deepStrictEqual(yield* inbox, [["1.0.0", "1.1.0"]])
        assert.strictEqual(yield* recorded, "1.1.0")
      })
    )

    it.effect("says nothing when it reconnects on the same version", () =>
      Effect.gen(function* () {
        yield* seed("1.1.0")
        yield* recordRelayVersionEffect(relay.id, "1.1.0")
        assert.deepStrictEqual(yield* inbox, [])
      })
    )

    it.effect("only records the first version it sees, or an older one", () =>
      Effect.gen(function* () {
        yield* seed(null)
        yield* recordRelayVersionEffect(relay.id, "1.1.0")
        yield* recordRelayVersionEffect(relay.id, "1.0.0")
        assert.deepStrictEqual(yield* inbox, [])
        assert.strictEqual(yield* recorded, "1.0.0")
      })
    )

    it.effect("records what the Relay says now, whatever asked", () =>
      Effect.gen(function* () {
        yield* seed("1.0.0")
        connected.version = "1.2.0"
        assert.strictEqual(
          yield* recordConnectedRelayVersionEffect(relay.id),
          "1.2.0"
        )
        assert.deepStrictEqual(yield* inbox, [["1.0.0", "1.2.0"]])

        // Gone since it asked: there's nothing to say, and nothing changes.
        connected.version = null
        assert.isNull(yield* recordConnectedRelayVersionEffect(relay.id))
        assert.strictEqual(yield* recorded, "1.2.0")
      })
    )

    it.effect("adds Relays and Hearth into one update while it's unread", () =>
      Effect.gen(function* () {
        yield* seed("1.0.0")
        yield* insertRelay("relay-b", {
          created_by: "owner",
          name: "Sydney",
          node_version: "1.0.0",
        })
        yield* TestClock.setTime(1_000)
        yield* notifyUsersEffect(["owner"], "kiln.updated:1.1.0", {
          kind: "kiln.updated",
          name: "v1.1.0 Nightly",
          previousName: "v0.9.0 Nightly",
          previousVersion: "0.9.0",
          url: null,
          version: "1.1.0",
        })
        yield* TestClock.setTime(2_000)
        yield* recordRelayVersionEffect(relay.id, "1.1.0")
        yield* TestClock.setTime(3_000)
        yield* recordRelayVersionEffect("relay-b", "1.1.0")

        const [only, ...others] = yield* listNotificationsEffect("owner")
        assert.deepStrictEqual(others, [])
        // The URL names whichever repository this Kiln updates from.
        assert.deepStrictEqual(
          { ...only?.content, url: null },
          {
            hearth: true,
            kind: "kiln.updated",
            name: "v1.1.0 Nightly",
            previousName: "v0.9.0 Nightly",
            previousVersion: "0.9.0",
            relays: [
              relayResource,
              {
                ...relayResource,
                id: "relay-b",
                name: "Sydney",
                relayId: "relay-b",
              },
            ],
            url: null,
            version: "1.1.0",
          }
        )
      })
    )

    it.effect("shows someone only the Relays they can update", () =>
      Effect.gen(function* () {
        yield* seed("1.0.0")
        yield* recordRelayVersionEffect(relay.id, "1.1.0")
        const [only] = yield* listNotificationsEffect("owner")
        assert.deepStrictEqual(
          only?.content.kind === "kiln.updated"
            ? [only.content.hearth, only.content.relays]
            : null,
          [false, [relayResource]]
        )
      })
    )

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

    it.effect("merges updates while unread, from where they started", () =>
      Effect.gen(function* () {
        yield* seed("1.0.0")
        yield* TestClock.setTime(1_000)
        yield* recordRelayVersionEffect(relay.id, "1.1.0")
        yield* TestClock.setTime(2_000)
        yield* recordRelayVersionEffect(relay.id, "1.2.0")
        assert.deepStrictEqual(yield* inbox, [["1.0.0", "1.2.0"]])

        yield* markNotificationsReadEffect("owner", "all")
        yield* TestClock.setTime(3_000)
        yield* recordRelayVersionEffect(relay.id, "1.3.0")
        assert.deepStrictEqual(yield* inbox, [["1.2.0", "1.3.0"]])
      })
    )
  })
})
