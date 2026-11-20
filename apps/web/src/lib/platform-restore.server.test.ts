import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, afterEach } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { DirectoryInstance } from "@/lib/instance-directory"
import { syncInstanceRegistryEffect } from "@/lib/instance-registry"
import { firstStartAfterRestore } from "@/lib/platform-restore.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertInstance, insertRelay, selectRows } from "@/test/seed"

// Restored onto a new machine, the Relay hosting Kiln has none of its old
// game servers yet. Their records, which their backups restore into, must
// outlast every start until each is back, then sync as before.

const directoryInstance: DirectoryInstance = {
  brickId: "minecraft-paper",
  connectAddress: "play.example.test:25565",
  game: "Minecraft",
  id: "aaaaaaaaaaaa",
  implementation: "Paper",
  name: "Survival",
  version: "1.21",
}

const records = Effect.map(
  selectRows<{ instance_id: string }>("instance"),
  (rows) => rows.map((row) => row.instance_id)
)

// Hearth's start: hears whether Kiln was restored, syncs the Relay's
// snapshot, then records the restore as heard once no record is missing.
const start = (listed: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const restore = yield* Effect.promise(() => firstStartAfterRestore())
    const { missing } = yield* syncInstanceRegistryEffect(
      "relay-one",
      listed.map((id) => ({ ...directoryInstance, id })),
      { prune: !restore.restored }
    )
    if (restore.restored && missing === 0) {
      yield* Effect.promise(() => restore.heard())
    }
  })

afterEach(() => {
  delete process.env.KILN_RESTORED_AT
})

describeMysql("Hearth after Kiln is restored", () => {
  layer(TestDatabase)((it) => {
    it.effect("keeps game server records until they're back", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay("relay-one")
        yield* insertInstance("relay-one", "aaaaaaaaaaaa")
        process.env.KILN_RESTORED_AT = "2026-11-17T12:00:00.000Z"

        // Hearth restarts before anyone restores the game server.
        yield* start([])
        yield* start([])
        assert.deepStrictEqual(yield* records, ["aaaaaaaaaaaa"])

        // Once it's back, later starts sync as any other.
        yield* start(["aaaaaaaaaaaa"])
        yield* start([])
        assert.deepStrictEqual(yield* records, [])
      })
    )
  })
})

afterAll(() => disposeAppRuntime())
