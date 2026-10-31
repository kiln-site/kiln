import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import {
  latestAppDeploymentsEffect,
  loadAppDeploymentRequestEffect,
} from "@/effect/app-deployments"
import {
  createAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import { databaseTableName } from "@/lib/database-config"
import { queueDurableOperation } from "@/operations/durable"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, insertUser } from "@/test/seed"

// The Relay is the only fake: one deployment per app, refusing another
// while it runs, as the Relay does, and an outcome journal by command ID.
const relay = vi.hoisted(() => ({
  count: 0,
  deployments: new Map<string, { id: string; state: string }>(),
  journal: new Map<string, { result: unknown; status: "succeeded" }>(),
  sent: [] as Array<string>,
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set(["connected"]),
  relayJournal: async () => ({ clientId: "hearth-one", journalId: "one" }),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: {
      appId?: string
      operationId?: string
      requests?: Array<{ id: string }>
    },
    _timeout?: number,
    _subject?: string,
    _signal?: AbortSignal,
    frame: { operationId?: string } = {}
  ) => {
    if (operation === "operation.get") {
      return (
        relay.journal.get(payload.operationId ?? "") ?? { status: "unknown" }
      )
    }
    if (operation === "app.deploy") {
      const appId = payload.appId!
      if (relay.deployments.get(appId)?.state === "running") {
        throw new Error("A deployment is already running")
      }
      const deployment = { id: `deployment-${++relay.count}`, state: "running" }
      relay.deployments.set(appId, deployment)
      relay.sent.push(appId)
      const result = relayApp(appId)
      if (frame.operationId) {
        relay.journal.set(frame.operationId, { result, status: "succeeded" })
      }
      return result
    }
    if (operation === "app.list") {
      const id = payload.requests![0]!.id
      return [{ app: relayApp(id), id, view: "detail" }]
    }
    return {}
  },
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const first = "a".repeat(40)
const second = "b".repeat(40)
// Apart from the others, whose deployments a test may leave running.
const third = "c".repeat(40)

function relayApp(id: string) {
  const deployment = relay.deployments.get(id)
  const now = new Date().toISOString()
  return {
    connectedDatabaseIds: [],
    containers: [],
    dataDirectory: `/srv/kiln/apps/${id}`,
    deployment: deployment
      ? {
          commit: null,
          error: null,
          finishedAt: deployment.state === "running" ? null : now,
          id: deployment.id,
          rolling: null,
          sourceType: "image",
          startedAt: now,
          state: deployment.state,
        }
      : null,
    hostname: `app-${id.slice(0, 8)}`,
    id,
    network: `kiln-app-${id.slice(0, 8)}`,
    observedState: "running",
    savedDatabaseIds: [],
    shortId: id.slice(0, 8),
    status: "Running",
  }
}

const Lanes = Layer.unwrap(
  Effect.promise(() => import("@/lib/app-deployments.server")).pipe(
    Effect.map(({ deployAppOperation }) =>
      testOperationsEngine(deployAppOperation.layer)
    )
  )
).pipe(Layer.provideMerge(TestDatabase))

const seedApp = (appId: string) =>
  Effect.gen(function* () {
    yield* createAppRecordEffect({
      appId,
      createdBy: "owner",
      name: `app-${appId.slice(0, 4)}`,
      relayId,
    })
    yield* updateAppConfigEffect(relayId, appId, (config) => ({
      ...config,
      image: "ghcr.io/kiln-site/marketing:latest",
      sourceType: "image",
    }))
  })

const deploy = (appId: string) =>
  Effect.promise(() => import("@/lib/app-deployments.server")).pipe(
    Effect.flatMap(({ deployAppOperation }) =>
      queueDurableOperation(deployAppOperation, {
        appId,
        explicit: { trigger: "manual", userId: null },
        relayId,
      })
    )
  )

const sentTo = (appId: string) =>
  relay.sent.filter((sent) => sent === appId).length

const until = (done: () => boolean) =>
  Effect.sync(done).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (finished) => finished,
    }),
    Effect.timeout("20 seconds")
  )

describeMysql("App deployments", () => {
  layer(Lanes, { timeout: 90_000 })((it) => {
    it.effect(
      "deploy one at a time per app, the next once the running one ends",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.count = 0
          relay.deployments.clear()
          relay.journal.clear()
          relay.sent.length = 0
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          // Its Relay already has the apps' database connections.
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(first)
          yield* seedApp(second)

          yield* deploy(first)
          yield* until(() => sentTo(first) === 1)

          // Another deploy of the same app waits its turn; another app's
          // goes ahead meanwhile.
          yield* deploy(first)
          yield* deploy(second)
          yield* until(() => sentTo(second) === 1)
          yield* Effect.sleep("3 seconds")
          assert.strictEqual(sentTo(first), 1)

          // The build ends: it's recorded, and the next deploys.
          relay.deployments.set(first, {
            ...relay.deployments.get(first)!,
            state: "succeeded",
          })
          yield* until(() => sentTo(first) === 2)
          const history = yield* latestAppDeploymentsEffect(first)
          assert.strictEqual(
            history.succeeded?.relayDeploymentId,
            "deployment-1"
          )
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "settle what a deletion skipped, so a request after it fails queues anew",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.count = 0
          relay.deployments.clear()
          relay.journal.clear()
          relay.sent.length = 0
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(third)
          yield* insertRows("resource_deletion", {
            actor: "{}",
            created_at: 0,
            final_backup: 0,
            id: "11111111-1111-4111-8111-111111111111",
            relay_id: relayId,
            requested_by: "owner",
            resource_id: third,
            resource_kind: "app",
            status: "pending",
            updated_at: 0,
          })
          const { queueAppDeploymentEffect } = yield* Effect.promise(
            () => import("@/lib/app-deployments.server")
          )
          const settled = Effect.suspend(() =>
            loadAppDeploymentRequestEffect(third)
          ).pipe(
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (pending) => pending === null,
            }),
            Effect.timeout("20 seconds")
          )

          // Being deleted: nothing deploys, and the update it asked is settled.
          yield* queueAppDeploymentEffect(third, relayId, "update")
          yield* settled
          assert.isNull((yield* latestAppDeploymentsEffect(third)).latest)

          // The deletion was cancelled: the next update is taken up afresh,
          // as far as this Relay can, which can't deploy updates.
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE ${sql(databaseTableName("resource_deletion"))} SET status = 'cancelled'`
          yield* queueAppDeploymentEffect(third, relayId, "update")
          yield* settled
          assert.strictEqual(
            (yield* latestAppDeploymentsEffect(third)).latest?.status,
            "failed"
          )
        }).pipe(TestClock.withLive),
      60_000
    )
  })
})
