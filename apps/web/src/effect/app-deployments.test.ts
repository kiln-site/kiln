import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { vi } from "vite-plus/test"

import {
  cancelAppDeploymentRequestEffect,
  loadAppDeploymentRequestEffect,
  loadAppDeploymentRequestsEffect,
  requestAppDeploymentEffect,
  takeAppDeploymentRequestEffect,
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
      "deploy the newest ask, keeping a person's until a deployment takes it",
      () =>
        Effect.gen(function* () {
          yield* seedApp
          const source = "42/main"
          const push = (sha: string) =>
            requestAppDeploymentEffect({
              appId,
              commit: { sha: sha.repeat(40), source },
              relayId,
              trigger: "push",
            })

          // Two merges in quick succession: the newest's commit wins.
          yield* push("a")
          yield* push("b")
          assert.deepInclude(yield* loadAppDeploymentRequestEffect(appId), {
            commitSha: "b".repeat(40),
            requestedBy: null,
            trigger: "push",
          })

          // A person's deploy asks for the newest, and is kept as theirs
          // when a push and a poll join it, the push's commit the newest.
          yield* requestAppDeploymentEffect({
            appId,
            relayId,
            trigger: "manual",
            userId: "sam",
          })
          yield* push("c")
          yield* requestAppDeploymentEffect({ appId, relayId, trigger: "poll" })
          assert.deepInclude(yield* loadAppDeploymentRequestEffect(appId), {
            commitSha: "c".repeat(40),
            requestedBy: "sam",
            trigger: "push",
          })

          // A redeploy pins its digest, and a later deploy replaces it.
          yield* requestAppDeploymentEffect({
            appId,
            image: { digest: "sha256:old", source: "web:latest" },
            relayId,
            trigger: "redeploy",
            userId: "sam",
          })
          assert.deepInclude(yield* loadAppDeploymentRequestEffect(appId), {
            commitSha: null,
            imageDigest: "sha256:old",
            trigger: "redeploy",
          })
          yield* requestAppDeploymentEffect({
            appId,
            relayId,
            trigger: "manual",
            userId: "alex",
          })
          assert.deepInclude(yield* loadAppDeploymentRequestEffect(appId), {
            imageDigest: null,
            requestedBy: "alex",
            trigger: "manual",
          })
          // Kept for a Hearth that restarts before taking it.
          assert.deepStrictEqual(
            (yield* loadAppDeploymentRequestsEffect()).map(
              (request) => request.appId
            ),
            [appId]
          )

          // Taken as a deployment plans: nothing waits, and the same
          // deployment's step run again gets what it took.
          const taken = yield* takeAppDeploymentRequestEffect(appId, "one")
          assert.strictEqual(taken?.requestedBy, "alex")
          assert.isNull(yield* loadAppDeploymentRequestEffect(appId))
          assert.deepInclude(
            yield* takeAppDeploymentRequestEffect(appId, "one"),
            { requestedBy: "alex", trigger: "manual" }
          )
          assert.isNull(yield* takeAppDeploymentRequestEffect(appId, "two"))

          // An ask after one taken starts afresh: just a poll, for the
          // branch head, nobody's.
          yield* requestAppDeploymentEffect({ appId, relayId, trigger: "poll" })
          assert.deepInclude(
            yield* takeAppDeploymentRequestEffect(appId, "two"),
            {
              commitSha: null,
              requestedBy: null,
              trigger: "poll",
            }
          )
        })
    )

    it.effect(
      "cancel only the ask shown, while no deployment has taken it",
      () =>
        Effect.gen(function* () {
          yield* seedApp
          const ask = requestAppDeploymentEffect({
            appId,
            relayId,
            trigger: "manual",
            userId: "sam",
          })
          yield* ask
          const shown = (yield* loadAppDeploymentRequestEffect(appId))!.revision

          // Another ask joined it since: the one shown isn't all that waits.
          yield* ask
          assert.isFalse(yield* cancelAppDeploymentRequestEffect(appId, shown))
          const now = (yield* loadAppDeploymentRequestEffect(appId))!.revision
          assert.isTrue(yield* cancelAppDeploymentRequestEffect(appId, now))
          assert.isNull(yield* loadAppDeploymentRequestEffect(appId))
          assert.isNull(yield* takeAppDeploymentRequestEffect(appId, "one"))

          // Taken already: it has started.
          yield* ask
          const taking = (yield* loadAppDeploymentRequestEffect(appId))!
            .revision
          yield* takeAppDeploymentRequestEffect(appId, "two")
          assert.isFalse(yield* cancelAppDeploymentRequestEffect(appId, taking))
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
