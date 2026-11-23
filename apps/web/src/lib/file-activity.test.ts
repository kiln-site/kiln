import { assert, layer } from "@effect/vitest"
import { relayFileRootId } from "@workspace/contracts"
import { Effect } from "effect"

import {
  listFileActivityEffect,
  pinRelayHostFilesEffect,
} from "@/lib/file-activity"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, selectRows } from "@/test/seed"

describeMysql("a Relay's pinned host files", () => {
  layer(TestDatabase)((it) => {
    it.effect("are the Relay's own, and no game server's", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const relayId = "1".repeat(12)
        yield* insertRelay(relayId)

        assert.isTrue(yield* pinRelayHostFilesEffect(relayId, ["relay.sqlite"]))
        // What's pinned already stays as it is.
        assert.isFalse(
          yield* pinRelayHostFilesEffect(relayId, ["relay.sqlite"])
        )

        const { files } = yield* listFileActivityEffect(
          relayId,
          relayFileRootId(relayId)
        )
        assert.deepStrictEqual(
          files.map((file) => [file.path, file.pinned]),
          [["relay.sqlite", true]]
        )
        assert.deepStrictEqual(yield* selectRows("instance"), [])
      })
    )
  })
})
