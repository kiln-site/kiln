import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { vi } from "vite-plus/test"

import {
  finishAppDeploymentEffect,
  insertAppDeploymentEffect,
  listAppDeploymentsEffect,
  loadAppDeploymentEffect,
  loadAppGitHubSourceEffect,
  saveAppGitHubSourceEffect,
  type AppDeploymentRecord,
} from "@/effect/app-deployments"
import {
  createAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { startAppDeploymentEffect } from "@/lib/app-deployments.server"
import { databaseTableName } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, selectRows } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const connectionId = "c".repeat(36)

const insertConnection = insertRows("github_connection", {
  app_id: 1,
  app_name: "kiln",
  app_owner_login: "acme",
  app_slug: "kiln",
  app_url: "https://github.com/apps/kiln",
  client_id: "client",
  created_at: 0,
  credentials_ciphertext: "unused",
  id: connectionId,
  owner_user_id: "user",
  updated_at: 0,
})

const seedApp = Effect.gen(function* () {
  yield* insertRelay(relayId)
  yield* insertRows("app", {
    app_id: appId,
    config_ciphertext: "unused",
    created_at: 0,
    created_by: "user",
    name: "Website",
    relay_id: relayId,
    updated_at: 0,
  })
})

function deployment(
  startedAt: number,
  change: Partial<AppDeploymentRecord> = {}
): AppDeploymentRecord {
  return {
    appId,
    branch: "main",
    commitAuthor: null,
    commitMessage: "Ship it",
    commitSha: "0".repeat(40),
    error: null,
    finishedAt: null,
    id: randomUUID(),
    relayDeploymentId: "20261020102017",
    relayId,
    repository: "acme/site",
    rolling: null,
    sourceType: "github",
    startedAt: new Date(startedAt).toISOString(),
    status: "running",
    trigger: "push",
    triggeredBy: null,
    ...change,
  }
}

describeMysql("App deployments", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "records how a deployment ended once, however many check it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedApp
          const record = deployment(Date.UTC(2026, 9, 20))
          yield* insertAppDeploymentEffect(record)

          const finished = yield* Effect.all(
            [
              finishAppDeploymentEffect(record.id, {
                error: null,
                finishedAt: "2026-10-20T10:21:00.000Z",
                rolling: true,
                status: "succeeded",
              }),
              finishAppDeploymentEffect(record.id, {
                error: "Kiln lost track of this deployment",
                finishedAt: "2026-10-20T10:22:00.000Z",
                rolling: null,
                status: "unknown",
              }),
            ],
            { concurrency: "unbounded" }
          )

          const saved = yield* loadAppDeploymentEffect(record.id)
          assert.deepStrictEqual([...finished].sort((left, right) => Number(left) - Number(right)), [false, true])
          assert.strictEqual(saved?.status, finished[0] ? "succeeded" : "unknown")
        })
    )

    it.effect("keeps each app's 200 newest deployments", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* seedApp
        const start = Date.UTC(2026, 9, 1)
        yield* insertRows(
          "app_deployment",
          Array.from({ length: 201 }, (_, index) => ({
            app_id: appId,
            id: randomUUID(),
            relay_id: relayId,
            source_type: "image",
            started_at: start + index * 60_000,
            status: "succeeded",
            trigger: "manual",
          }))
        )

        yield* insertAppDeploymentEffect(
          deployment(start + 201 * 60_000, { status: "succeeded" })
        )
        const kept = yield* listAppDeploymentsEffect({
          appId,
          limit: 500,
          relayIds: [relayId],
        })

        assert.strictEqual(kept.length, 200)
        assert.strictEqual(
          kept.at(-1)?.startedAt,
          new Date(start + 2 * 60_000).toISOString()
        )
      })
    )

    it.effect(
      "keeps an app's repository when the source it was read with is removed",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* seedApp
          yield* insertConnection
          yield* saveAppGitHubSourceEffect({
            appId,
            autoDeploy: true,
            branch: "main",
            build: "compose",
            connectionId,
            createdBy: "user",
            path: "deploy/compose.yaml",
            repository: "acme/site",
            repositoryId: 42,
          })

          const sql = yield* SqlClient.SqlClient
          yield* sql`DELETE FROM ${sql(databaseTableName("github_connection"))}`
          const source = yield* loadAppGitHubSourceEffect(appId)

          assert.deepStrictEqual(source, {
            appId,
            autoDeploy: true,
            branch: "main",
            build: "compose",
            connectionId: null,
            createdBy: "user",
            path: "deploy/compose.yaml",
            relayId,
            repository: "acme/site",
            repositoryId: 42,
          })
        })
    )

    it.effect(
      "deploys nothing a push queued once deploying on push is turned off",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* createAppRecordEffect({
            appId,
            createdBy: "user",
            name: "Website",
            relayId,
          })
          yield* updateAppConfigEffect(relayId, appId, (config) => ({
            ...config,
            sourceType: "github",
          }))
          yield* insertConnection
          yield* saveAppGitHubSourceEffect({
            appId,
            autoDeploy: false,
            branch: "main",
            build: "dockerfile",
            connectionId,
            createdBy: "user",
            path: "Dockerfile",
            repository: "acme/site",
            repositoryId: 42,
          })

          const started = yield* startAppDeploymentEffect({
            appId,
            relayId,
            trigger: "push",
            userId: null,
          })

          assert.strictEqual(started, null)
          assert.deepStrictEqual(yield* selectRows("app_deployment"), [])
        })
    )
  })
})
