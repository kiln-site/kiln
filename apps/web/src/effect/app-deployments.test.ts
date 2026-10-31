import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import {
  loadAppDeploymentRequestEffect,
  loadAppDeploymentRequestsEffect,
  requestAppDeploymentEffect,
  settleAppDeploymentRequestEffect,
} from "@/effect/app-deployments"
import {
  createAppRecordEffect,
  deleteAppRecordEffect,
} from "@/effect/managed-apps"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "r".repeat(43)
const appId = "a".repeat(40)

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

describeMysql("App deployment requests", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keep every request that comes while one deploys, until a pass starts from it",
      () =>
        Effect.gen(function* () {
          yield* seedApp
          // Two merges in quick succession, and an image update found due.
          yield* requestAppDeploymentEffect({ appId, relayId, trigger: "push" })
          yield* requestAppDeploymentEffect({ appId, relayId, trigger: "push" })
          yield* requestAppDeploymentEffect({
            appId,
            relayId,
            trigger: "update",
          })
          const taken = yield* loadAppDeploymentRequestEffect(appId)
          assert.deepInclude(taken, {
            imageUpdate: true,
            poll: false,
            push: true,
          })

          // A push lands while that pass deploys: settling the pass leaves
          // it waiting, every kind asked for still kept.
          yield* requestAppDeploymentEffect({ appId, relayId, trigger: "poll" })
          assert.isFalse(
            yield* settleAppDeploymentRequestEffect(appId, taken!.revision)
          )
          const next = yield* loadAppDeploymentRequestEffect(appId)
          assert.deepInclude(next, {
            imageUpdate: true,
            poll: true,
            push: true,
          })
          assert.isAbove(next!.revision, taken!.revision)
          // Kept for a Hearth that restarts before taking it.
          assert.deepStrictEqual(
            (yield* loadAppDeploymentRequestsEffect()).map(
              (request) => request.appId
            ),
            [appId]
          )

          // The pass that starts from the latest settles it.
          assert.isTrue(
            yield* settleAppDeploymentRequestEffect(appId, next!.revision)
          )
          assert.isNull(yield* loadAppDeploymentRequestEffect(appId))
        })
    )

    it.effect("go with their app", () =>
      Effect.gen(function* () {
        yield* seedApp
        yield* requestAppDeploymentEffect({ appId, relayId, trigger: "push" })
        yield* deleteAppRecordEffect(relayId, appId)
        assert.isNull(yield* loadAppDeploymentRequestEffect(appId))
      })
    )
  })
})
