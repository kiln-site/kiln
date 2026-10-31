import { assert, layer } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import {
  loadAppImageUpdateEffect,
  recordAppImageCheckEffect,
  saveAppImageUpdatePolicyEffect,
} from "@/effect/app-image-updates"
import {
  createAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { insertAppDeploymentEffect } from "@/effect/app-deployments"
import { notifyUsersEffect, openSourceKeysEffect } from "@/effect/notifications"
import {
  recordCheckedAppImageEffect,
  resolveAppImageUpdateNotificationsEffect,
} from "@/lib/app-image-updates.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const image = "ghcr.io/kiln-site/marketing:latest"
const digest = (n: number) => `sha256:${String(n).repeat(64)}`

describeMysql("App image checks", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "stop offering an update a check found before the App deployed again",
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
          yield* saveAppImageUpdatePolicyEffect(appId, {
            delayHours: 0,
            mode: "notify",
          })
          const askedAt = 1_800_000_000_000
          yield* TestClock.setTime(askedAt)
          yield* recordAppImageCheckEffect(
            appId,
            image,
            {
              appId,
              latestDigest: digest(2),
              runningDigests: [digest(1)],
              status: "checked",
            },
            askedAt
          )
          const sourceKey = `app.image-update:${appId}:${digest(2)}`
          yield* notifyUsersEffect(["user"], sourceKey, {
            digest: digest(2),
            image,
            kind: "app.image-update",
            resource: { id: appId, name: "Website", relayId, type: "app" },
          })
          const open = openSourceKeysEffect(
            "app.image-update",
            `app.image-update:${appId}:`
          )

          // Still what the App runs: the offer stands.
          yield* resolveAppImageUpdateNotificationsEffect(relayId, appId)
          assert.deepStrictEqual(yield* open, [sourceKey])

          // A deployment since may have changed what it runs: what the check
          // found no longer offers anything, until the next one.
          yield* insertAppDeploymentEffect({
            appId,
            branch: null,
            commitAuthor: null,
            commitMessage: null,
            commitSha: null,
            error: null,
            finishedAt: null,
            id: "deployment-after-check",
            imageDigest: null,
            relayDeploymentId: "20261031120000",
            relayId,
            repository: null,
            rolling: null,
            sourceType: "image",
            startedAt: new Date(askedAt + 60_000).toISOString(),
            status: "running",
            trigger: "manual",
            triggeredBy: "user",
          })
          yield* resolveAppImageUpdateNotificationsEffect(relayId, appId)
          assert.deepStrictEqual(yield* open, [])
        })
    )

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
          yield* saveAppImageUpdatePolicyEffect(appId, {
            delayHours: 0,
            mode: "notify",
          })
          const askedAt = 1_800_000_000_000
          const newer = yield* recordAppImageCheckEffect(
            appId,
            image,
            {
              appId,
              latestDigest: digest(3),
              runningDigests: [digest(1)],
              status: "checked",
            },
            askedAt
          )
          assert.isTrue(newer.newlySeen)

          // Asked earlier, it answers after: it says nothing new.
          const older = yield* recordAppImageCheckEffect(
            appId,
            image,
            { appId, error: "registry timed out", status: "error" },
            askedAt - 60_000
          )
          assert.isFalse(older.newFailure)
          assert.isFalse(older.newlySeen)

          const kept = yield* loadAppImageUpdateEffect(appId)
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
          yield* saveAppImageUpdatePolicyEffect(appId, {
            delayHours: 0,
            mode: "notify",
          })
          yield* recordAppImageCheckEffect(
            appId,
            image,
            {
              appId,
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
          yield* recordCheckedAppImageEffect(
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
