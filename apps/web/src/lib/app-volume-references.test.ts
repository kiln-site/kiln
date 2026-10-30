import { assert, layer } from "@effect/vitest"
import type { AppMount } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  createAppRecordEffect,
  importRelayAppVolumeReferencesEffect,
  loadAppConfigEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

// The Relay is the boundary: the volumes it holds each App's configuration
// names, and the volumes it has.
const relay = vi.hoisted(() => ({
  existing: new Set<string>(),
  imported: [] as Array<{ appId: string; volumeIds: Array<string> }>,
  references: new Map<string, Array<string>>(),
  unresolved: [] as Array<string>,
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: {
      apps?: Array<{ appId: string; volumeIds: Array<string> }>
      appId?: string
      unresolvedAppIds?: Array<string>
      volumeIds?: Array<string>
    }
  ) => {
    if (operation === "relay.volumes.references.import") {
      relay.references = new Map(
        payload.apps!.map((app) => [app.appId, app.volumeIds])
      )
      relay.imported = payload.apps!
      relay.unresolved = payload.unresolvedAppIds!
      return { apps: payload.apps!.length }
    }
    if (operation !== "app.volumes.write") {
      throw new Error(`Unexpected Relay operation ${operation}`)
    }
    const before = relay.references.get(payload.appId!) ?? []
    if (
      payload.volumeIds!.some(
        (id) => !before.includes(id) && !relay.existing.has(id)
      )
    ) {
      throw new Error("A volume it mounts no longer exists; choose another")
    }
    relay.references.set(payload.appId!, payload.volumeIds!)
    return payload
  },
}))

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const otherAppId = "b".repeat(40)
const media = "1".repeat(40)
const uploads = "2".repeat(40)
const gone = "3".repeat(40)

const volumeMount = (id: string, volumeId: string): AppMount => ({
  id,
  readOnly: false,
  service: null,
  source: { type: "volume", volumeId },
  target: `/${id}`,
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  relay.existing = new Set([media, uploads])
  relay.imported = []
  relay.references = new Map()
  relay.unresolved = []
  yield* insertUser("owner")
  yield* insertRelay(relayId, { created_by: "owner" })
  for (const id of [appId, otherAppId]) {
    yield* createAppRecordEffect({
      appId: id,
      createdBy: "owner",
      name: id.slice(0, 1),
      relayId,
    })
  }
})

const mountVolumes = (id: string, mounts: Array<AppMount>) =>
  updateAppConfigEffect(relayId, id, (config) => ({ ...config, mounts }))

const savedVolumes = (id: string) =>
  Effect.map(loadAppConfigEffect(relayId, id), (app) =>
    app!.config.mounts.flatMap((mount) =>
      mount.source.type === "volume" ? [mount.source.volumeId] : []
    )
  )

describeMysql("App volume references", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps the Relay knowing every volume a saved configuration mounts",
      () =>
        Effect.gen(function* () {
          yield* seed

          yield* mountVolumes(appId, [volumeMount("media0001", media)])
          assert.deepStrictEqual(relay.references.get(appId), [media])

          // A volume the Relay no longer has isn't saved.
          const refused = yield* Effect.flip(
            mountVolumes(appId, [
              volumeMount("media0001", media),
              volumeMount("gone0001", gone),
            ])
          )
          assert.include(String(refused), "no longer exists")
          assert.deepStrictEqual(yield* savedVolumes(appId), [media])
          assert.deepStrictEqual(relay.references.get(appId), [media])

          // Swapping one volume for another: the Relay keeps both until the
          // configuration that drops one is saved, then only what it names.
          yield* mountVolumes(appId, [volumeMount("uploads01", uploads)])
          assert.deepStrictEqual(yield* savedVolumes(appId), [uploads])
          assert.deepStrictEqual(relay.references.get(appId), [uploads])

          yield* mountVolumes(appId, [])
          assert.deepStrictEqual(relay.references.get(appId), [])
        })
    )

    it.effect(
      "tells the Relay which Apps' configurations it couldn't read, instead of leaving them out",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* mountVolumes(appId, [volumeMount("media0001", media)])
          yield* mountVolumes(otherAppId, [volumeMount("uploads01", uploads)])
          // As when the secret it was saved with is gone.
          const database = yield* Database
          yield* database.execute(
            "corrupt_app_config",
            `UPDATE ${databaseTable("app")} SET config_ciphertext = ? WHERE app_id = ?`,
            ["unreadable", otherAppId]
          )

          const imported = yield* importRelayAppVolumeReferencesEffect(relayId)

          assert.deepStrictEqual(imported, { unresolved: 1 })
          assert.deepStrictEqual(relay.imported, [
            { appId, volumeIds: [media] },
          ])
          assert.deepStrictEqual(relay.unresolved, [otherAppId])
        })
    )
  })
})
