import { generateKeyPairSync } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect, Layer, Schedule } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, beforeAll, vi } from "vite-plus/test"

import {
  finishAppDeploymentEffect,
  insertAppDeploymentEffect,
  latestAppDeploymentsEffect,
  loadAppGitHubSourceEffect,
  saveAppGitHubSourceEffect,
} from "@/effect/app-deployments"
import {
  createAppRecordEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import { databaseTableName } from "@/lib/database-config"
import { betterAuthSecrets } from "@/lib/environment"
import { operationsTablePrefix } from "@/operations/engine"
import { readmitWaitingOperations } from "@/operations/durable"
import { loadOperation } from "@/operations/records"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertRows, insertUser, selectRows } from "@/test/seed"

import { encryptWithKeyring } from "../../keyring.mjs"

// The Relay is the only fake: one deployment per app, refusing another
// while it runs, as the Relay does, and an outcome journal by command ID.
const relay = vi.hoisted(() => ({
  count: 0,
  configs: [] as Array<{ environment?: string } | undefined>,
  // Whether each deployment sent, in order, skipped the build cache.
  noCache: [] as Array<boolean>,
  deployments: new Map<string, { id: string; state: string }>(),
  journal: new Map<string, { result: unknown; status: "succeeded" }>(),
  // Apps it doesn't have, as one whose provisioning failed.
  missing: new Set<string>(),
  // Each app's saved database connections, and where the databases that
  // haven't finished provisioning are.
  connections: new Map<string, Array<string>>(),
  databaseLists: 0,
  provisioning: new Map<string, string>(),
  sent: [] as Array<string>,
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set(["app-github-v1", "connected"]),
  relayJournal: async () => ({ clientId: "hearth-one", journalId: "one" }),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: {
      appId?: string
      config?: { environment?: string }
      noCache?: boolean
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
      relay.configs.push(payload.config)
      relay.noCache.push(payload.noCache === true)
      const result = relayApp(appId)
      if (frame.operationId) {
        relay.journal.set(frame.operationId, { result, status: "succeeded" })
      }
      return result
    }
    if (operation === "app.list") {
      const id = payload.requests![0]!.id
      if (relay.missing.has(id)) return []
      return [{ app: relayApp(id), id, view: "detail" }]
    }
    if (operation === "database.list") {
      relay.databaseLists++
      return [...relay.provisioning].map(([id, phase]) =>
        relayDatabase(id, phase)
      )
    }
    return {}
  },
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

// GitHub, for an installation's token and the branch head a test moves.
// Effect's fetch client keeps the first `fetch` it sees, so the fake is
// installed once and its answer changes instead.
let branchHead = ""
let branchHeadReads = 0
const github = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(input instanceof Request ? input.url : String(input))
  if (url.pathname.endsWith("/access_tokens")) {
    return Response.json({
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      token: "installation-token",
    })
  }
  branchHeadReads++
  return Response.json({
    author: { login: "octo" },
    commit: { author: { name: "Octo" }, message: "A commit" },
    sha: branchHead,
  })
})

beforeAll(() => {
  vi.stubGlobal("fetch", github)
})

afterAll(async () => {
  vi.unstubAllGlobals()
  await disposeAppRuntime()
})

const relayId = "r".repeat(43)
const first = "a".repeat(40)
const second = "b".repeat(40)
// Apart from the others, whose deployments a test may leave running.
const third = "c".repeat(40)
const fourth = "d".repeat(40)
const fifth = "e".repeat(40)
const sixth = "f".repeat(40)
const seventh = "7".repeat(40)
const eighth = "8".repeat(40)
const ninth = "9".repeat(40)

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
    savedDatabaseIds: relay.connections.get(id) ?? [],
    shortId: id.slice(0, 8),
    status: "Running",
  }
}

function relayDatabase(id: string, phase: string) {
  return {
    containerId: null,
    createdAt: new Date(0).toISOString(),
    databaseName: "kiln_main",
    engine: "postgres",
    hostname: `database-${id}`,
    id,
    image: "postgres:17",
    internalPort: 5432,
    members: [],
    name: "Main",
    observedState: "provisioning",
    provisioning: { attempt: 0, error: null, phase },
    shortId: id.slice(0, 8),
    status: "Preparing database",
    supportsImportExport: true,
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

// A connection GitHub can't push to, so Hearth polls its apps' branches.
const polledConnectionId = "22222222-2222-4222-8222-222222222222"
const seedPolledConnection = Effect.gen(function* () {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
  yield* insertRows("github_connection", {
    id: polledConnectionId,
    owner_user_id: "owner",
    app_id: 4242,
    app_slug: "kiln-test",
    app_name: "Kiln test",
    app_url: "https://github.com/apps/kiln-test",
    app_owner_login: "octo",
    client_id: "Iv1.test",
    credentials_ciphertext: encryptWithKeyring(
      JSON.stringify({
        clientSecret: "client-secret",
        privateKey: privateKey.export({ format: "pem", type: "pkcs1" }),
        webhookSecret: "webhook-secret",
      }),
      betterAuthSecrets(),
      "kiln-github-app-credentials"
    ),
    webhook_active: false,
    installation_id: 777,
    account_login: "octo",
    account_type: "User",
    repository_selection: "selected",
    suspended: false,
    created_at: 0,
    updated_at: 0,
  })
})

const saveSource = (
  appId: string,
  branch: string,
  baselineCommit: string,
  repository = "octo/app"
) =>
  saveAppGitHubSourceEffect({
    appId,
    autoDeploy: true,
    baselineCommit,
    branch,
    build: "dockerfile",
    connectionId: polledConnectionId,
    createdBy: "owner",
    path: "Dockerfile",
    repository,
    repositoryId: 1,
  })

const seedPolledApp = (appId: string) =>
  Effect.gen(function* () {
    yield* createAppRecordEffect({
      appId,
      createdBy: "owner",
      name: `app-${appId.slice(0, 4)}`,
      relayId,
    })
    yield* updateAppConfigEffect(relayId, appId, (config) => ({
      ...config,
      sourceType: "github",
    }))
  })

// The app's last deployment, from a branch it may have moved on from.
const seedDeployed = (appId: string, branch: string, id: string) =>
  insertAppDeploymentEffect({
    appId,
    branch,
    commitAuthor: null,
    commitMessage: null,
    commitSha: "3".repeat(40),
    error: null,
    finishedAt: new Date(1_000).toISOString(),
    id,
    imageDigest: null,
    relayDeploymentId: "20261031090000",
    relayId,
    repository: "octo/app",
    rolling: null,
    sourceType: "github",
    startedAt: new Date(0).toISOString(),
    status: "succeeded",
    trigger: "manual",
    triggeredBy: null,
  })

// What `check` finds while the minute poll runs, stopping it however that
// ends.
const whilePolling = <A, E, R>(check: Effect.Effect<A, E, R>) =>
  Effect.promise(() => import("@/lib/app-deployments.server")).pipe(
    Effect.flatMap(({ startAppDeploymentPolling, stopAppDeploymentPolling }) =>
      Effect.sync(startAppDeploymentPolling).pipe(
        Effect.andThen(check),
        Effect.ensuring(Effect.promise(stopAppDeploymentPolling))
      )
    )
  )

const ask = (
  appId: string,
  trigger: "manual" | "update" = "manual",
  userId: string | null = null,
  awaitProvisioning = false,
  noCache = false
) =>
  Effect.promise(() => import("@/lib/app-deployments.server")).pipe(
    Effect.flatMap(({ askAppDeploymentEffect }) =>
      askAppDeploymentEffect({
        appId,
        awaitProvisioning,
        noCache,
        relayId,
        trigger,
        userId,
      })
    )
  )
const deploy = (appId: string) => ask(appId)

// Until the deployment operation `id` has ended, however it went.
const ended = (id: string) =>
  Effect.suspend(() => loadOperation(id)).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("100 millis"),
      until: (found) =>
        found !== null &&
        found.state !== "running" &&
        found.state !== "waiting",
    }),
    Effect.timeout("20 seconds")
  )

// The commit each app's queued deployment asks for.
const queuedDeploys = selectRows<{ id: string; kind: string }>(
  "operation"
).pipe(
  Effect.flatMap((rows) =>
    Effect.forEach(
      rows.filter(({ kind }) => kind === "app.deploy"),
      ({ id }) => loadOperation(id)
    )
  ),
  Effect.map(
    (operations) =>
      new Map(
        operations.map((operation) => {
          const input = operation!.input as {
            appId: string
            commit?: { value: string }
          }
          return [input.appId, input.commit?.value]
        })
      )
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

          // Two more asks of the same app wait their turn as one; another
          // app's goes ahead meanwhile.
          yield* deploy(first)
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
          yield* Effect.sleep("3 seconds")
          assert.strictEqual(sentTo(first), 2)
          const history = yield* latestAppDeploymentsEffect(first)
          assert.strictEqual(
            history.succeeded?.relayDeploymentId,
            "deployment-1"
          )
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "send an App's secrets to its Relay without keeping them in the operation",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.configs.length = 0
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(fourth)
          const secret = "DATABASE_PASSWORD=never-kept-in-the-clear"
          yield* updateAppConfigEffect(relayId, fourth, (config) => ({
            ...config,
            environment: secret,
          }))

          yield* deploy(fourth)
          yield* until(() => sentTo(fourth) === 1)
          assert.strictEqual(relay.configs.at(-1)?.environment, secret)

          // Nothing the operation stored holds it.
          const sql = yield* SqlClient.SqlClient
          for (const table of ["messages", "replies"]) {
            const rows =
              yield* sql`SELECT * FROM ${sql(`${operationsTablePrefix()}_${table}`)}`
            assert.isFalse(JSON.stringify(rows).includes("never-kept"), table)
          }
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "refuse a person's ask once they may no longer manage the app",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.sent.length = 0
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(fifth)

          // Asked by someone whose account is gone when its turn comes.
          yield* ask(fifth, "manual", "removed-person")
          const refused = yield* Effect.suspend(() =>
            latestAppDeploymentsEffect(fifth)
          ).pipe(
            Effect.map(({ latest }) => latest),
            Effect.repeat({
              schedule: Schedule.spaced("100 millis"),
              until: (latest) => latest !== null,
            }),
            Effect.timeout("20 seconds")
          )
          assert.strictEqual(refused?.status, "failed")
          assert.strictEqual(refused?.triggeredBy, "removed-person")
          assert.strictEqual(sentTo(fifth), 0)
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "wait for a connected database still provisioning, but not one that failed",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.sent.length = 0
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(ninth)
          const database = "b".repeat(40)
          relay.connections.set(ninth, [database])
          relay.provisioning.set(database, "pulling_image")

          // Its containers couldn't join a network that isn't there yet.
          const id = yield* ask(ninth)
          yield* until(() => relay.databaseLists > 0)
          assert.strictEqual((yield* loadOperation(id))?.state, "waiting")
          assert.strictEqual(sentTo(ninth), 0)

          // One that failed will never have one, so it goes without.
          relay.provisioning.set(database, "failed")
          yield* readmitWaitingOperations
          yield* until(() => sentTo(ninth) === 1)
          relay.connections.clear()
          relay.provisioning.clear()
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "deploy a new app asked again once it's there, though its first deploy gave up",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.sent.length = 0
          relay.missing.add(sixth)
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(sixth)

          // Its Relay doesn't have it: its first deploy gives up.
          yield* ended(yield* ask(sixth, "manual", null, true))

          // Asked again once it's there, it deploys.
          relay.missing.delete(sixth)
          yield* ask(sixth)
          yield* until(() => sentTo(sixth) === 1)
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "wait for a deployment from before deployments queued to end, then deploy",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.sent.length = 0
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(seventh)
          // Running as Hearth upgraded, with no operation holding it.
          yield* insertAppDeploymentEffect({
            appId: seventh,
            branch: null,
            commitAuthor: null,
            commitMessage: null,
            commitSha: null,
            error: null,
            finishedAt: null,
            id: "11111111-2222-4333-8444-555555555555",
            imageDigest: null,
            relayDeploymentId: "20261031090000",
            relayId,
            repository: null,
            rolling: null,
            sourceType: "image",
            startedAt: new Date().toISOString(),
            status: "running",
            trigger: "manual",
            triggeredBy: null,
          })

          // Asked meanwhile, it waits rather than meet the build running.
          const id = yield* ask(seventh)
          yield* Effect.sleep("500 millis")
          assert.strictEqual((yield* loadOperation(id))?.state, "waiting")
          assert.strictEqual(sentTo(seventh), 0)

          // Settled, as the minute sweep does, it deploys.
          yield* finishAppDeploymentEffect(
            "11111111-2222-4333-8444-555555555555",
            {
              error: null,
              finishedAt: new Date().toISOString(),
              rolling: null,
              status: "succeeded",
            }
          )
          yield* readmitWaitingOperations
          yield* until(() => sentTo(seventh) === 1)
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "skip the build cache once asked to, whatever joins the ask, and only for that deployment",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relay.count = 0
          relay.deployments.clear()
          relay.journal.clear()
          relay.noCache.length = 0
          relay.sent.length = 0
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* insertRows("relay_database_connection_import", {
            acknowledged_at: 0,
            configs_cleared_at: 0,
            relay_id: relayId,
          })
          yield* seedApp(eighth)
          const finish = () =>
            Effect.sync(() =>
              relay.deployments.set(eighth, {
                ...relay.deployments.get(eighth)!,
                state: "succeeded",
              })
            )

          yield* deploy(eighth)
          yield* until(() => sentTo(eighth) === 1)

          // Asked while one runs, then joined by a plain ask, as a push's.
          const joined = yield* ask(eighth, "manual", null, false, true)
          yield* deploy(eighth)
          yield* finish()
          yield* until(() => sentTo(eighth) === 2)

          yield* finish()
          yield* ended(joined)
          yield* deploy(eighth)
          yield* until(() => sentTo(eighth) === 3)

          assert.deepStrictEqual(relay.noCache, [false, true, false])
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "poll past what a branch held when chosen, deploying only a commit after it",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          // Disabled, so what's asked stays queued: the poll asks through
          // Hearth's engine, which can't run it beside this suite's.
          yield* insertRelay(relayId, { enabled: false })
          yield* insertUser("owner")
          yield* seedPolledConnection
          const held = "1".repeat(40)
          const pushed = "2".repeat(40)
          // Two of each, as a poll checks them in no set order and the last
          // read may not have finished.
          const created = ["a1".repeat(20), "a2".repeat(20)]
          const moved = ["b1".repeat(20), "b2".repeat(20)]
          for (const app of created) {
            yield* seedPolledApp(app)
            yield* saveSource(app, "main", held)
          }
          for (const [index, app] of moved.entries()) {
            yield* seedPolledApp(app)
            yield* saveSource(app, "main", "4".repeat(40))
            yield* seedDeployed(
              app,
              "main",
              `33333333-3333-4333-8333-33333333333${index}`
            )
            yield* saveSource(app, "dev", held)
          }

          // Created, or moved to another branch, with nothing new on it.
          branchHead = held
          branchHeadReads = 0
          yield* whilePolling(
            until(() => branchHeadReads >= created.length + moved.length)
          )
          assert.strictEqual((yield* queuedDeploys).size, 0)

          // A commit lands, and the source is saved again before any check
          // sees it: it's still a push, to all of them.
          branchHead = pushed
          yield* saveSource(created[0]!, "main", pushed)
          const queued = yield* whilePolling(
            queuedDeploys.pipe(
              Effect.repeat({
                schedule: Schedule.spaced("100 millis"),
                until: ({ size }) => size === created.length + moved.length,
              }),
              Effect.timeout("20 seconds")
            )
          )
          for (const app of [...created, ...moved]) {
            assert.strictEqual(queued.get(app), pushed)
          }
        }).pipe(TestClock.withLive),
      60_000
    )

    it.effect(
      "keep a source's baseline only while it's the very same branch",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          yield* seedPolledConnection
          yield* seedPolledApp(first)
          const baseline = Effect.map(
            loadAppGitHubSourceEffect(first),
            (source) => source?.baselineCommit
          )
          const [one, two, three, four] = ["1", "2", "3", "4"].map((digit) =>
            digit.repeat(40)
          )

          yield* saveSource(first, "main", one!)
          yield* saveSource(first, "main", two!)
          assert.strictEqual(yield* baseline, one)

          // Git's branches differ by case, whatever the column's collation.
          yield* saveSource(first, "Main", two!)
          assert.strictEqual(yield* baseline, two)

          yield* saveSource(first, "dev", three!)
          assert.strictEqual(yield* baseline, three)

          yield* saveSource(first, "dev", four!, "octo/renamed")
          assert.strictEqual(yield* baseline, four)
        })
    )

    it.effect("end a deploy queued for a Relay that's gone", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        const { askAppDeploymentEffect } = yield* Effect.promise(
          () => import("@/lib/app-deployments.server")
        )
        const id = yield* askAppDeploymentEffect({
          appId: "8".repeat(40),
          relayId: "z".repeat(43),
          trigger: "manual",
        })
        yield* ended(id)
        assert.strictEqual((yield* loadOperation(id))?.state, "succeeded")
      }).pipe(TestClock.withLive)
    )

    it.effect(
      "deploy nothing of an app being deleted, and what's asked after it as usual",
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

          // Being deleted: nothing deploys.
          yield* ended(yield* ask(third, "update"))
          assert.isNull((yield* latestAppDeploymentsEffect(third)).latest)

          // The deletion was cancelled: the next update is taken up afresh,
          // as far as this Relay can, which can't deploy updates.
          const sql = yield* SqlClient.SqlClient
          yield* sql`UPDATE ${sql(databaseTableName("resource_deletion"))} SET status = 'cancelled'`
          yield* ended(yield* ask(third, "update"))
          assert.strictEqual(
            (yield* latestAppDeploymentsEffect(third)).latest?.status,
            "failed"
          )
        }).pipe(TestClock.withLive),
      60_000
    )
  })
})
