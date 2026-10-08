import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { attachRelayOwnersEffect } from "@/effect/relay-owners"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

const relays = [
  { createdBy: "named", id: "relay-named" },
  { createdBy: "blank", id: "relay-blank" },
  { createdBy: null, id: "relay-unowned" },
]

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("named", {
    email: "named.owner@example.test",
    name: "Notch",
  })
  yield* insertUser("blank", { email: "private.person@example.test", name: "" })
})

describeMysql("Relay owner identity", () => {
  layer(TestDatabase)((it) => {
    it.effect("never derives names or emails for non-administrators", () =>
      Effect.gen(function* () {
        yield* seed

        const owners = yield* attachRelayOwnersEffect(relays, false)

        assert.deepStrictEqual(
          owners.map((owner) => owner.ownerEmail),
          [null, null, null]
        )
        assert.strictEqual(owners[0]?.ownerName, "Notch")
        assert.notInclude(owners[1]?.ownerName ?? "", "private")
        assert.isNull(owners[2]?.ownerName)
      })
    )

    it.effect("shows administrators owner emails and email fallbacks", () =>
      Effect.gen(function* () {
        yield* seed

        const owners = yield* attachRelayOwnersEffect(relays, true)

        assert.deepStrictEqual(
          owners.map(({ ownerEmail, ownerName }) => ({
            ownerEmail,
            ownerName,
          })),
          [
            { ownerEmail: "named.owner@example.test", ownerName: "Notch" },
            {
              ownerEmail: "private.person@example.test",
              ownerName: "private.person",
            },
            { ownerEmail: null, ownerName: null },
          ]
        )
      })
    )
  })
})
