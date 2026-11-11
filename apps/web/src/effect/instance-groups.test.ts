import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  addInstanceGroupMemberEffect,
  createInstanceGroupEffect,
  instanceGroupOfEffect,
  loadInstanceGroupEffect,
  removeInstanceGroupMemberEffect,
} from "@/effect/instance-groups"
import { deletePersistedRelayEffect } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

const here = "1".repeat(12)
const there = "2".repeat(12)
const group = "9".repeat(12)
const app = "a".repeat(12)
const database = "d".repeat(12)

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(here)
  yield* insertRelay(there)
  yield* createInstanceGroupEffect({
    createdBy: "alice",
    id: group,
    name: "Analytics",
  })
  yield* addInstanceGroupMemberEffect(group, {
    instanceId: database,
    kind: "database",
    relayId: here,
  })
  yield* addInstanceGroupMemberEffect(group, {
    instanceId: app,
    kind: "app",
    relayId: there,
  })
})

const members = Effect.map(loadInstanceGroupEffect(group), (found) =>
  found ? found.members.map((member) => member.instanceId) : null
)

describeMysql("Instance groups", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps a group until its last member is gone", () =>
      Effect.gen(function* () {
        yield* seed
        assert.deepStrictEqual(
          (yield* instanceGroupOfEffect(app))?.members.map(
            (member) => member.instanceId
          ),
          [app, database]
        )

        yield* removeInstanceGroupMemberEffect(app)
        assert.isNull(yield* instanceGroupOfEffect(app))
        assert.deepStrictEqual(yield* members, [database])

        // Its cleanup may run again, and for an instance in no group.
        yield* removeInstanceGroupMemberEffect(app)
        assert.deepStrictEqual(yield* members, [database])

        yield* removeInstanceGroupMemberEffect(database)
        assert.isNull(yield* members)
      })
    )

    // A group being installed has no members until its first is made.
    it.effect("leaves alone a group that lost no member", () =>
      Effect.gen(function* () {
        yield* seed
        const installing = "8".repeat(12)
        yield* createInstanceGroupEffect({
          createdBy: "alice",
          id: installing,
          name: "Installing",
        })
        yield* insertRelay("3".repeat(12))

        // Something in no group is deleted, a member of another group is,
        // and a Relay with nothing in any group is removed.
        yield* removeInstanceGroupMemberEffect("b".repeat(12))
        yield* removeInstanceGroupMemberEffect(app)
        yield* deletePersistedRelayEffect("3".repeat(12))

        assert.strictEqual(
          (yield* loadInstanceGroupEffect(installing))?.name,
          "Installing"
        )
      })
    )

    it.effect("takes a removed Relay's instances out of their groups", () =>
      Effect.gen(function* () {
        yield* seed

        yield* deletePersistedRelayEffect(here)
        assert.deepStrictEqual(yield* members, [app])

        yield* deletePersistedRelayEffect(there)
        assert.isNull(yield* members)
      })
    )
  })
})
