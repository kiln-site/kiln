import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import {
  createAppRecordEffect,
  listAppRecordsEffect,
  loadAppConfigEffect,
  renameAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

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

    it.effect("keeps both of two config changes saved at once", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        const appId = "a".repeat(40)
        yield* createAppRecordEffect({
          appId,
          createdBy: "user-one",
          name: "Website",
          relayId: relayOne,
        })

        // As an environment edit saved while a limits change waited on the
        // Relay.
        yield* Effect.all(
          [
            updateAppConfigEffect(relayOne, appId, (config) => ({
              ...config,
              environment: "MODE=production",
            })),
            updateAppConfigEffect(relayOne, appId, (config) => ({
              ...config,
              serviceLimits: { app: { cpuMillis: 500, memoryBytes: null } },
            })),
          ],
          { concurrency: "unbounded" }
        )

        const saved = yield* loadAppConfigEffect(relayOne, appId)
        assert.strictEqual(saved?.config.environment, "MODE=production")
        assert.deepStrictEqual(saved?.config.serviceLimits, {
          app: { cpuMillis: 500, memoryBytes: null },
        })
      })
    )

    it.effect("loads a config saved with fields apps no longer have", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertRelay(relayOne)
        const appId = "a".repeat(40)
        yield* createAppRecordEffect({
          appId,
          createdBy: "user-one",
          name: "Website",
          relayId: relayOne,
        })
        // As saved when apps mounted a data directory with a disk limit.
        yield* updateAppConfigEffect(relayOne, appId, (config) => ({
          ...config,
          dataMount: "/data",
          diskLimitBytes: 8 * 1024 ** 3,
          image: "nginx:latest",
        }))

        const saved = yield* loadAppConfigEffect(relayOne, appId)
        assert.strictEqual(saved?.config.image, "nginx:latest")
        assert.notProperty(saved?.config, "dataMount")
        assert.notProperty(saved?.config, "diskLimitBytes")
      })
    )
  })
})
