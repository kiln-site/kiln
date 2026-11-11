import { assert, layer } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { vi } from "vite-plus/test"

import {
  loadInstanceUpdateEffect,
  recordInstanceImageCheckEffect,
  saveInstanceUpdatePolicyEffect,
} from "@/effect/instance-updates"
import {
  createAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { notifyUsersEffect, openSourceKeysEffect } from "@/effect/notifications"
import { recordCheckedImageEffect } from "@/lib/instance-updates.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "1".repeat(12)
const appId = "a".repeat(12)
const image = "ghcr.io/kiln-site/marketing:latest"
const digest = (n: number) => `sha256:${String(n).repeat(64)}`

describeMysql("App image checks", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keep what a newer check found over an older one answering late",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("user")
          yield* createAppRecordEffect({
            appId,
            createdBy: "user",
            name: "Website",
            relayId,
          })
          yield* saveInstanceUpdatePolicyEffect("app", appId, {
            delayHours: 0,
            mode: "notify",
          })
          const askedAt = 1_800_000_000_000
          const newer = yield* recordInstanceImageCheckEffect(
            "app",
            appId,
            image,
            {
              id: appId,
              image,
              latestDigest: digest(3),
              runningDigests: [digest(1)],
              status: "checked",
            },
            askedAt
          )
          assert.isTrue(newer.newlySeen)

          // Asked earlier, it answers after: it says nothing new.
          const older = yield* recordInstanceImageCheckEffect(
            "app",
            appId,
            image,
            { id: appId, error: "registry timed out", status: "error" },
            askedAt - 60_000
          )
          assert.isFalse(older.newFailure)
          assert.isFalse(older.newlySeen)

          const kept = yield* loadInstanceUpdateEffect(appId)
          assert.strictEqual(kept?.latestDigest, digest(3))
          assert.strictEqual(kept?.checkedAt, askedAt)
        })
    )

    it.effect(
      "keep an update announced after an older check found checks off",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("user")
          yield* createAppRecordEffect({
            appId,
            createdBy: "user",
            name: "Website",
            relayId,
          })
          yield* updateAppConfigEffect(relayId, appId, (config) => ({
            ...config,
            image,
            sourceType: "image",
          }))
          // Checks are on, and a newer check found and announced an update.
          yield* saveInstanceUpdatePolicyEffect("app", appId, {
            delayHours: 0,
            mode: "notify",
          })
          yield* recordInstanceImageCheckEffect(
            "app",
            appId,
            image,
            {
              id: appId,
              image,
              latestDigest: digest(2),
              runningDigests: [digest(1)],
              status: "checked",
            },
            yield* Clock.currentTimeMillis
          )
          const sourceKey = `app.image-update:${appId}:${digest(2)}`
          yield* notifyUsersEffect(["user"], sourceKey, {
            digest: digest(2),
            image,
            kind: "app.image-update",
            resource: { id: appId, name: "Website", relayId, type: "app" },
          })

          // An older check, which found checks off, records after it.
          yield* recordCheckedImageEffect(
            "app",
            { id: relayId } as PersistedRelay,
            appId,
            { answers: [], unchecked: true },
            null
          )

          assert.deepStrictEqual(
            yield* openSourceKeysEffect(
              "app.image-update",
              `app.image-update:${appId}:`
            ),
            [sourceKey]
          )
        })
    )
  })
})
