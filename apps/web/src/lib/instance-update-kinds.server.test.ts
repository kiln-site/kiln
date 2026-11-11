import { assert, layer } from "@effect/vitest"
import { Clock, Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { insertServerDeploymentEffect } from "@/effect/app-deployments"
import {
  recordInstanceBrickCheckEffect,
  recordInstanceImageCheckEffect,
  saveInstanceUpdatePolicyEffect,
  skipInstanceUpdateEffect,
} from "@/effect/instance-updates"
import { createManagedDatabaseRecordEffect } from "@/effect/managed-databases"
import { disposeAppRuntime } from "@/effect/runtime"
import type { PersistedRelay } from "@/lib/relay-registry"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

// The Relay is the only fake: it keeps each database it was asked to
// deploy again.
const relay = vi.hoisted(() => ({ deployed: [] as Array<string> }))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { id?: string }
  ) => {
    if (operation === "instance.image.check") return []
    if (operation !== "instance.deploy") return {}
    relay.deployed.push(String(payload.id))
    return {
      containerId: "c".repeat(64),
      createdAt: new Date(0).toISOString(),
      databaseName: "kiln_main",
      engine: "postgres",
      hostname: `database-${String(payload.id)}`,
      id: payload.id,
      image: "postgres:17",
      internalPort: 5432,
      members: [],
      name: "Main",
      observedState: "running",
      status: "Running",
      supportsImportExport: true,
    }
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))
// Catalogs are fetched over the network. Theirs has revision 2 of whatever
// Brick is asked about.
vi.mock("@/lib/brick-revisions.server", () => ({
  newestBrickRevision: async (source: string) => ({
    definition: {},
    name: "PostgreSQL",
    revision: 2,
    source,
  }),
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

const relayId = "1".repeat(12)
const databaseId = "d".repeat(12)
const digest = (n: number) => `sha256:${String(n).repeat(64)}`

const Lanes = testOperationsEngine(Layer.empty).pipe(
  Layer.provideMerge(TestDatabase)
)

// A database whose tag names a newer image, set to update on its own once
// that has waited.
const seedDue = (delayHours: number) =>
  Effect.gen(function* () {
    yield* resetDatabase
    relay.deployed.length = 0
    yield* insertRelay(relayId, { enabled: 1 })
    yield* insertUser("owner")
    yield* createManagedDatabaseRecordEffect({
      brickId: "postgres",
      brickSource: "https://bricks.test/postgres.yml",
      createdBy: "owner",
      databaseId,
      databaseName: "kiln_main",
      engine: "postgres",
      internalPort: 5432,
      name: "Main",
      password: "the-password",
      relayId,
      username: "kiln_user",
    })
    yield* saveInstanceUpdatePolicyEffect("database", databaseId, {
      delayHours,
      mode: "auto",
    })
    yield* recordInstanceImageCheckEffect(
      "database",
      databaseId,
      "postgres:17",
      {
        id: databaseId,
        image: "postgres:17",
        latestDigest: digest(2),
        runningDigests: [digest(1)],
        status: "checked",
      },
      yield* Clock.currentTimeMillis
    )
    const { updatedKind } = yield* Effect.promise(
      () => import("@/lib/instance-update-kinds.server")
    )
    // What a check that found it due hands over.
    return updatedKind("database").autoUpdate(
      { enabled: true, id: relayId } as PersistedRelay,
      databaseId,
      { digest: digest(2), of: "image" }
    )
  })

// Kiln decides again as it takes the instance: what a check found due a
// moment ago may not be by then.
describeMysql("An update Kiln takes on its own", () => {
  layer(Lanes)((it) => {
    it.effect("deploys an image that has waited, once however it went", () =>
      Effect.gen(function* () {
        const update = yield* seedDue(0)
        yield* update
        assert.deepStrictEqual(relay.deployed, [databaseId])
        // Found due again, as while its next check still sees the tag.
        yield* update
        assert.deepStrictEqual(relay.deployed, [databaseId])
      }).pipe(TestClock.withLive)
    )

    it.effect("deploys nothing that was passed over since it was found", () =>
      Effect.gen(function* () {
        const update = yield* seedDue(0)
        yield* skipInstanceUpdateEffect(databaseId, digest(2))
        yield* update
        assert.deepStrictEqual(relay.deployed, [])
      }).pipe(TestClock.withLive)
    )

    it.effect("deploys nothing once its instance no longer updates on its own", () =>
      Effect.gen(function* () {
        const update = yield* seedDue(0)
        yield* saveInstanceUpdatePolicyEffect("database", databaseId, {
          delayHours: 0,
          mode: "notify",
        })
        yield* update
        assert.deepStrictEqual(relay.deployed, [])
      }).pipe(TestClock.withLive)
    )

    // A deployment may have changed the Brick an instance runs, as a change
    // of Brick does: what was seen of it before one is not installed from.
    it.effect(
      "installs its Brick's newer revision as last seen, and nothing seen before a deployment since",
      () =>
        Effect.gen(function* () {
          yield* seedDue(0)
          const { updatedKind } = yield* Effect.promise(
            () => import("@/lib/instance-update-kinds.server")
          )
          const install = updatedKind("database").autoUpdate(
            { enabled: true, id: relayId } as PersistedRelay,
            databaseId,
            { of: "brick", revision: 2 }
          )
          const seen = (revision: number) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((askedAt) =>
                recordInstanceBrickCheckEffect(
                  "database",
                  databaseId,
                  { revision, source: "https://bricks.test/postgres.yml" },
                  2,
                  askedAt
                )
              )
            )

          yield* seen(1)
          // Deployed since, as by a person: what it runs isn't known yet.
          yield* insertServerDeploymentEffect({
            brickId: null,
            brickName: null,
            id: "11111111-1111-4111-8111-111111111111",
            instanceId: databaseId,
            kind: "database",
            relayId,
            trigger: "redeploy",
            triggeredBy: null,
          })
          yield* install
          assert.deepStrictEqual(relay.deployed, [])

          // Seen again after it, still a revision behind.
          yield* Effect.sleep("5 millis")
          yield* seen(1)
          yield* install
          assert.deepStrictEqual(relay.deployed, [databaseId])
        }).pipe(TestClock.withLive)
    )

    it.effect("deploys nothing whose wait was made longer than it has waited", () =>
      Effect.gen(function* () {
        const update = yield* seedDue(0)
        yield* saveInstanceUpdatePolicyEffect("database", databaseId, {
          delayHours: 24,
          mode: "auto",
        })
        yield* update
        assert.deepStrictEqual(relay.deployed, [])
      }).pipe(TestClock.withLive)
    )
  })
})
