import { assert, layer } from "@effect/vitest"
import { defaultAppConfig } from "@workspace/contracts"
import { Effect } from "effect"
import { afterEach, vi } from "vite-plus/test"

import {
  decryptWithKeyring,
  encryptWithKeyring,
  parseSecretKeyring,
} from "../../keyring.mjs"
import {
  loadAppConfigEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { betterAuthSecrets } from "@/lib/environment"
import type { PersistedRelay } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

// The Relay control channel is the only external boundary here.
const relay = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock("@/lib/relay-connection", () => ({ relayRpc: relay.rpc }))

import { ensureAppDatabaseConnectionsImportedEffect } from "./app-database-connections.server"

const PURPOSE = "kiln-app-config"
const website = "a".repeat(40)
const docs = "b".repeat(40)
const postgres = "d".repeat(40)
const redis = "e".repeat(40)

const KEYRING = `1:${"x".repeat(32)}`
vi.stubEnv("BETTER_AUTH_SECRETS", KEYRING)
// A secret Hearth's keyring lost, then got back.
const RETIRED_KEY = `2:${"y".repeat(32)}`

// An App saved by a Hearth that kept its database connections in its config.
const insertLegacyApp = (
  relayId: string,
  appId: string,
  databaseIds: ReadonlyArray<string>,
  keyring = betterAuthSecrets()
) =>
  insertRows("app", {
    app_id: appId,
    relay_id: relayId,
    name: appId.slice(0, 8),
    config_ciphertext: encryptWithKeyring(
      JSON.stringify({ ...defaultAppConfig, databaseIds }),
      keyring,
      PURPOSE
    ),
    created_by: "user-one",
    created_at: 0,
    updated_at: 0,
  })

const storedConfigs = Effect.map(
  selectRows<{ app_id: string; config_ciphertext: string }>("app"),
  (rows) =>
    Object.fromEntries(
      rows.map((row) => [
        row.app_id,
        JSON.parse(
          decryptWithKeyring(
            row.config_ciphertext,
            betterAuthSecrets(),
            PURPOSE
          ).plaintext
        ) as Record<string, unknown>,
      ])
    )
)

const imports = selectRows<{
  relay_id: string
  acknowledged_at: number | null
  configs_cleared_at: number | null
}>("relay_database_connection_import")

// What a Hearth that restarted knows: only what MySQL kept.
const restartHearth = () => globalThis.kilnDatabaseConnectionImports?.clear()

const persistedRelay = (id: string) => ({ enabled: true, id }) as PersistedRelay

afterEach(() => {
  relay.rpc.mockReset()
  restartHearth()
  vi.stubEnv("BETTER_AUTH_SECRETS", KEYRING)
})

describeMysql("handing Apps' database connections to their Relay", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keeps the configs' connections until the Relay acknowledges them, then hands them over once",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const relayId = "r".repeat(43)
          yield* insertRelay(relayId)
          yield* insertLegacyApp(relayId, website, [postgres, redis])
          yield* insertLegacyApp(relayId, docs, [])
          // An edit before the handover keeps them.
          yield* updateAppConfigEffect(relayId, website, (config) => ({
            ...config,
            environment: "GREETING=hello",
          }))
          relay.rpc
            .mockRejectedValueOnce(new Error("Relay connection closed"))
            .mockResolvedValue({ imported: 2 })

          // The reply is lost, as when Hearth or the connection goes down.
          const lost = yield* Effect.flip(
            ensureAppDatabaseConnectionsImportedEffect(persistedRelay(relayId))
          )
          assert.match(String(lost), /Relay connection closed/u)
          assert.deepStrictEqual(yield* imports, [])
          assert.deepStrictEqual(
            (yield* storedConfigs)[website]?.databaseIds,
            [postgres, redis]
          )

          restartHearth()
          yield* ensureAppDatabaseConnectionsImportedEffect(
            persistedRelay(relayId)
          )
          const handover = {
            apps: [{ appId: website, databaseIds: [postgres, redis] }],
          }
          assert.deepStrictEqual(
            relay.rpc.mock.calls.map((call) => [call[1], call[2]]),
            [
              ["database.network.import", handover],
              ["database.network.import", handover],
            ]
          )
          const [recorded] = yield* imports
          assert.strictEqual(recorded?.relay_id, relayId)
          assert.isNotNull(recorded?.configs_cleared_at)
          const configs = yield* storedConfigs
          assert.notProperty(configs[website], "databaseIds")
          assert.notProperty(configs[docs], "databaseIds")
          assert.strictEqual(
            (yield* loadAppConfigEffect(relayId, website))?.config.environment,
            "GREETING=hello"
          )

          // A restarted Hearth doesn't hand them over again.
          restartHearth()
          yield* ensureAppDatabaseConnectionsImportedEffect(
            persistedRelay(relayId)
          )
          assert.strictEqual(relay.rpc.mock.calls.length, 2)
        })
    )

    it.effect(
      "clears the configs a crash left behind after the Relay acknowledged, sending them again for the Relay to keep as they are",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const relayId = "s".repeat(43)
          yield* insertRelay(relayId)
          yield* insertLegacyApp(relayId, website, [postgres])
          yield* insertRows("relay_database_connection_import", {
            relay_id: relayId,
            acknowledged_at: 1,
            configs_cleared_at: null,
          })

          // The Relay already has them, and adds nothing.
          relay.rpc.mockResolvedValue({ imported: 0 })

          yield* ensureAppDatabaseConnectionsImportedEffect(
            persistedRelay(relayId)
          )

          assert.strictEqual(relay.rpc.mock.calls.length, 1)
          assert.notProperty((yield* storedConfigs)[website], "databaseIds")
          assert.isNotNull((yield* imports)[0]?.configs_cleared_at)
        })
    )

    it.effect(
      "hands over an App whose config couldn't be read once its secret is back, and only then completes",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const relayId = "u".repeat(43)
          yield* insertRelay(relayId)
          yield* insertLegacyApp(relayId, website, [postgres])
          yield* insertLegacyApp(
            relayId,
            docs,
            [redis],
            parseSecretKeyring(RETIRED_KEY)
          )
          relay.rpc.mockResolvedValue({ imported: 1 })

          // The secret `docs` was saved with is gone.
          yield* ensureAppDatabaseConnectionsImportedEffect(
            persistedRelay(relayId)
          )
          assert.deepStrictEqual(
            relay.rpc.mock.calls.map((call) => call[2]),
            [{ apps: [{ appId: website, databaseIds: [postgres] }] }]
          )
          assert.isNull((yield* imports)[0]?.configs_cleared_at)
          // Asked again, as a deploy would, it still can't, and sends
          // nothing it has sent.
          yield* ensureAppDatabaseConnectionsImportedEffect(
            persistedRelay(relayId)
          )
          assert.strictEqual(relay.rpc.mock.calls.length, 1)

          // Restored, and Hearth restarted with it.
          vi.stubEnv("BETTER_AUTH_SECRETS", `${KEYRING},${RETIRED_KEY}`)
          restartHearth()
          yield* ensureAppDatabaseConnectionsImportedEffect(
            persistedRelay(relayId)
          )
          assert.deepStrictEqual(relay.rpc.mock.calls[1]?.[2], {
            apps: [{ appId: docs, databaseIds: [redis] }],
          })
          assert.isNotNull((yield* imports)[0]?.configs_cleared_at)
          assert.notProperty((yield* storedConfigs)[docs], "databaseIds")
        })
    )

    it.effect(
      "records a Relay with nothing to hand over without asking it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          const relayId = "t".repeat(43)
          yield* insertRelay(relayId)
          yield* insertLegacyApp(relayId, website, [])

          yield* ensureAppDatabaseConnectionsImportedEffect(
            persistedRelay(relayId)
          )

          assert.strictEqual(relay.rpc.mock.calls.length, 0)
          assert.lengthOf(yield* imports, 1)
          assert.notProperty((yield* storedConfigs)[website], "databaseIds")
        })
    )
  })
})
