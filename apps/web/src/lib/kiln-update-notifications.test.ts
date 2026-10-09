import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"

import { listNotificationsEffect } from "@/effect/notifications"
import { recordStartedKilnVersionEffect } from "@/lib/kiln-update-notifications"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

const updates = (userId: string) =>
  Effect.map(listNotificationsEffect(userId), (notifications) =>
    notifications.flatMap(({ content }) =>
      content.kind === "kiln.updated"
        ? [`${content.previousVersion} -> ${content.version}`]
        : []
    )
  )

describeMysql("Kiln update notifications", () => {
  layer(TestDatabase)((it) => {
    it.effect("tells admins once when Hearth starts on a newer version", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("admin", { role: "admin" })
        yield* insertUser("member", { role: "user" })

        // A fresh install has nothing to compare against.
        yield* recordStartedKilnVersionEffect("0.2.0")
        yield* recordStartedKilnVersionEffect("0.2.0")
        assert.deepStrictEqual(yield* updates("admin"), [])

        yield* recordStartedKilnVersionEffect("0.3.0")
        yield* recordStartedKilnVersionEffect("0.3.0")
        assert.deepStrictEqual(yield* updates("admin"), ["0.2.0 -> 0.3.0"])
        assert.deepStrictEqual(yield* updates("member"), [])

        // Rolling back is not an update.
        yield* recordStartedKilnVersionEffect("0.2.0")
        assert.deepStrictEqual(yield* updates("admin"), ["0.2.0 -> 0.3.0"])
      })
    )
  })
})
