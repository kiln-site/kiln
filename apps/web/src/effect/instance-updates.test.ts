import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import { insertAppDeploymentEffect } from "@/effect/app-deployments"
import {
  autoUpdateAt,
  claimImageUpdateEffect,
  loadInstanceUpdateEffect,
  offeredBrickRevision,
  recordInstanceBrickCheckEffect,
  skipInstanceBrickUpdateEffect,
  recordInstanceImageCheckEffect,
  saveInstanceUpdatePolicyEffect,
  skipInstanceUpdateEffect,
} from "@/effect/instance-updates"
import { createAppRecordEffect } from "@/effect/managed-apps"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "1".repeat(12)
const appId = "a".repeat(12)
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

// A check asked about the image now.
const record = (result: Parameters<typeof recordInstanceImageCheckEffect>[3]) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) =>
      recordInstanceImageCheckEffect(
            "app",
            appId, image, result, now)
    )
  )

const checked = (latest: number, running: Array<number>) =>
  record({
    id: appId,
    image,
    latestDigest: digest(latest),
    runningDigests: running.map(digest),
    status: "checked",
  })

describeMysql("App image updates", () => {
  layer(TestDatabase)((it) => {
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

          yield* saveInstanceUpdatePolicyEffect("app", appId, {
            delayHours: 72,
            mode: "auto",
          })
          const waiting = yield* checked(2, [1])
          assert.strictEqual(autoUpdateAt(waiting.update), start + 72 * hour)

          // A failed check can't say the tag still names it, so it waits for
          // one that gets through, its wait kept.
          const failed = yield* record({
            id: appId,
            error: "ghcr.io answered 503",
            status: "error",
          })
          assert.isNull(autoUpdateAt(failed.update))
          const recovered = yield* checked(2, [1])
          assert.strictEqual(autoUpdateAt(recovered.update), start + 72 * hour)

          assert.isTrue(yield* skipInstanceUpdateEffect(appId, digest(2)))
          const skipped = yield* checked(2, [1])
          assert.isNull(autoUpdateAt(skipped.update))
          // A newer image than the one skipped is offered as any other.
          const newer = yield* checked(3, [1])
          assert.strictEqual(autoUpdateAt(newer.update), start + 72 * hour)
          // Skipping what's no longer on offer does nothing.
          assert.isFalse(yield* skipInstanceUpdateEffect(appId, digest(2)))

          // One update claims each digest, before the Relay hears of it; the
          // same deployment, run again after a restart, still has it.
          assert.isTrue(
            yield* claimImageUpdateEffect(appId, digest(3), "deployment-one")
          )
          assert.isTrue(
            yield* claimImageUpdateEffect(appId, digest(3), "deployment-one")
          )
          assert.isFalse(
            yield* claimImageUpdateEffect(appId, digest(3), "deployment-two")
          )

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
          assert.isFalse(
            yield* claimImageUpdateEffect(appId, digest(3), "deployment-two")
          )
        })
    )

    it.effect(
      "offers a Brick's newer revision once, and not one passed over",
      () =>
        Effect.gen(function* () {
          yield* seedApp
          const source = "https://bricks.test/paper.yml"
          const found = (installed: number, catalog: number | null) =>
            recordInstanceBrickCheckEffect(
              "server",
              appId,
              { revision: installed, source },
              catalog
            )
          const offered = loadInstanceUpdateEffect(appId).pipe(
            Effect.map((update) => update && offeredBrickRevision(update))
          )

          const first = yield* found(1, 2)
          assert.isTrue(first.newlySeen)
          assert.strictEqual(yield* offered, 2)
          // Seen again, it's the same offer, waiting since it was first seen.
          const again = yield* found(1, 2)
          assert.isFalse(again.newlySeen)
          assert.strictEqual(again.brick.latestSeenAt, first.brick.latestSeenAt)

          assert.isTrue(yield* skipInstanceBrickUpdateEffect(appId, 2))
          assert.isNull(yield* offered)
          // Passing over one revision doesn't pass over the next.
          assert.isTrue((yield* found(1, 3)).newlySeen)
          assert.strictEqual(yield* offered, 3)

          // Installed, or gone from its catalog, there is nothing to offer.
          assert.isNull((yield* found(3, 3)).brick.latestRevision)
          assert.isNull((yield* found(3, null)).brick.latestRevision)
          assert.isNull(yield* offered)
        })
    )
  })
})
