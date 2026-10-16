import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import {
  listAppRecordsEffect,
  renameAppRecordEffect,
} from "@/effect/managed-apps"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

const relayOne = "r".repeat(43)
const relayTwo = "s".repeat(43)

const insertApp = (relayId: string, appId: string, name: string) =>
  insertRows("app", {
    app_id: appId,
    relay_id: relayId,
    name,
    config_ciphertext: "unused",
    created_by: "user-one",
    created_at: 0,
    updated_at: 0,
  })

describeMysql("managed apps", () => {
  layer(TestDatabase)((it) => {
    it.effect("renames an app unless another on its Relay has the name", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        yield* insertRelay(relayTwo)
        yield* insertApp(relayOne, "a".repeat(40), "Website")
        yield* insertApp(relayOne, "b".repeat(40), "Docs")
        yield* insertApp(relayTwo, "c".repeat(40), "Elsewhere")

        const error = yield* Effect.flip(
          renameAppRecordEffect(relayOne, "b".repeat(40), "Website")
        )
        assert.match(error.message, /already exists/u)
        yield* renameAppRecordEffect(relayOne, "b".repeat(40), "Elsewhere")

        const names = (yield* listAppRecordsEffect())
          .map((record) => [record.appId.charAt(0), record.name])
          .sort(([left], [right]) => left!.localeCompare(right!))
        assert.deepStrictEqual(names, [
          ["a", "Website"],
          ["b", "Elsewhere"],
          ["c", "Elsewhere"],
        ])
      })
    )

    it.effect("refuses to rename an app that doesn't exist", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)

        const error = yield* Effect.flip(
          renameAppRecordEffect(relayOne, "d".repeat(40), "Website")
        )
        assert.match(error.message, /not found/u)
      })
    )
  })
})
