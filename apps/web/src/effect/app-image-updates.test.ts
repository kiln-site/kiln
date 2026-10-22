import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import { insertAppDeploymentEffect } from "@/effect/app-deployments"
import {
  autoUpdateAt,
  claimImageUpdateEffect,
  recordAppImageCheckEffect,
  saveAppImageUpdatePolicyEffect,
  skipAppImageUpdateEffect,
} from "@/effect/app-image-updates"
import { createAppRecordEffect } from "@/effect/managed-apps"
import { resourceAudienceEffect } from "@/lib/resource-audience.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const image = "ghcr.io/kiln-site/marketing:latest"
const digest = (n: number) => `sha256:${String(n).repeat(64)}`
const hour = 3_600_000

const seedApp = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  yield* createAppRecordEffect({
    appId,
    createdBy: "user",
    name: "Website",
    relayId,
  })
})

const checked = (latest: number, running: Array<number>) =>
  recordAppImageCheckEffect(appId, image, {
    appId,
    latestDigest: digest(latest),
    runningDigests: running.map(digest),
    status: "checked",
  })

describeMysql("App image updates", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "offers each new image once, and restarts its wait when the tag moves again",
      () =>
        Effect.gen(function* () {
          yield* seedApp
          yield* TestClock.setTime(Date.UTC(2026, 9, 20))

          const current = yield* checked(1, [1])
          assert.strictEqual(current.update.state, "current")
          assert.isFalse(current.newlySeen)

          const offered = yield* checked(2, [1])
          const seenAt = offered.update.latestSeenAt
          assert.strictEqual(offered.update.state, "available")
          assert.isTrue(offered.newlySeen)
          assert.strictEqual(seenAt, Date.UTC(2026, 9, 20))

          // Checked again, and a check that fails, change nothing about it.
          yield* TestClock.adjust(hour)
          const again = yield* checked(2, [1])
          assert.isFalse(again.newlySeen)
          assert.strictEqual(again.update.latestSeenAt, seenAt)
          const failed = yield* recordAppImageCheckEffect(appId, image, {
            appId,
            error: "ghcr.io answered 503",
            status: "error",
          })
          assert.strictEqual(failed.update.state, "available")
          assert.strictEqual(failed.update.latestDigest, digest(2))
          assert.strictEqual(failed.update.latestSeenAt, seenAt)
          assert.strictEqual(failed.update.checkError, "ghcr.io answered 503")

          // The tag moved on before it deployed: the newest image waits anew.
          yield* TestClock.adjust(hour)
          const moved = yield* checked(3, [1])
          assert.isTrue(moved.newlySeen)
          assert.strictEqual(moved.update.latestDigest, digest(3))
          assert.strictEqual(moved.update.latestSeenAt, seenAt! + 2 * hour)
          assert.isNull(moved.update.checkError)

          const deployed = yield* checked(3, [3])
          assert.strictEqual(deployed.update.state, "current")
          assert.isNull(deployed.update.latestDigest)
        })
    )

    it.effect(
      "deploys an update on its own only once it has waited, and never one skipped or already tried",
      () =>
        Effect.gen(function* () {
          yield* seedApp
          const start = Date.UTC(2026, 9, 20)
          yield* TestClock.setTime(start)

          // Notifying is the default: nothing deploys on its own.
          const notified = yield* checked(2, [1])
          assert.isNull(autoUpdateAt(notified.update))

          yield* saveAppImageUpdatePolicyEffect(appId, {
            delayHours: 72,
            mode: "auto",
          })
          const waiting = yield* checked(2, [1])
          assert.strictEqual(autoUpdateAt(waiting.update), start + 72 * hour)

          // A failed check can't say the tag still names it, so it waits for
          // one that gets through, its wait kept.
          const failed = yield* recordAppImageCheckEffect(appId, image, {
            appId,
            error: "ghcr.io answered 503",
            status: "error",
          })
          assert.isNull(autoUpdateAt(failed.update))
          const recovered = yield* checked(2, [1])
          assert.strictEqual(autoUpdateAt(recovered.update), start + 72 * hour)

          assert.isTrue(yield* skipAppImageUpdateEffect(appId, digest(2)))
          const skipped = yield* checked(2, [1])
          assert.isNull(autoUpdateAt(skipped.update))
          // A newer image than the one skipped is offered as any other.
          const newer = yield* checked(3, [1])
          assert.strictEqual(autoUpdateAt(newer.update), start + 72 * hour)
          // Skipping what's no longer on offer does nothing.
          assert.isFalse(yield* skipAppImageUpdateEffect(appId, digest(2)))

          // One update claims each digest, before the Relay hears of it.
          assert.isTrue(yield* claimImageUpdateEffect(appId, digest(3)))
          assert.isFalse(yield* claimImageUpdateEffect(appId, digest(3)))

          // Still, once the app's history has pruned every record of it.
          for (let index = 1; index <= 200; index += 1) {
            const at = new Date(start + index * 1_000).toISOString()
            yield* insertAppDeploymentEffect({
              appId,
              branch: null,
              commitAuthor: null,
              commitMessage: null,
              commitSha: null,
              error: null,
              finishedAt: at,
              id: randomUUID(),
              imageDigest: null,
              relayDeploymentId: null,
              relayId,
              repository: null,
              rolling: null,
              sourceType: "image",
              startedAt: at,
              status: "failed",
              trigger: "manual",
              triggeredBy: null,
            })
          }
          assert.isFalse(yield* claimImageUpdateEffect(appId, digest(3)))
        })
    )

    it.effect("tells only enabled people who can deploy the Relay's apps", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* insertUser("owner", { status: "enabled" })
        yield* insertUser("former", { status: "disabled" })
        yield* insertRelay(relayId, { created_by: "owner" })
        yield* insertRelay("s".repeat(43), { created_by: "former" })
        const scope = (id: string) => ({
          relayId: id,
          resourceId: id,
          resourceType: "relay" as const,
        })

        assert.deepStrictEqual(
          yield* resourceAudienceEffect(scope(relayId), "app.manage"),
          ["owner"]
        )
        assert.deepStrictEqual(
          yield* resourceAudienceEffect(scope("s".repeat(43)), "app.manage"),
          []
        )
      })
    )
  })
})
