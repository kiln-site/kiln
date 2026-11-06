import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { loadAppConfigEffect } from "@/effect/managed-apps"
import {
  createManagedDatabaseRecordEffect,
  loadManagedDatabaseCredentialEffect,
} from "@/effect/managed-databases"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { runOperation } from "@/operations/operation"
import { createDatabase } from "@/server/database-create.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

// The Relay control channel is the only external boundary here. It keeps
// the connections an App's job would save, and each new instance's job.
const relay = vi.hoisted(() => ({
  connections: new Map<string, ReadonlyArray<string>>(),
  jobs: [] as Array<string>,
}))

vi.mock("@/lib/relay-connection", () => ({
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: Record<string, unknown> & { databaseIds?: Array<string> }
  ) => {
    switch (operation) {
      case "app.provision.prepare":
        relay.jobs.push(String(payload.id))
        relay.connections.set(String(payload.id), payload.databaseIds ?? [])
        return {
          connectedDatabaseIds: [],
          containers: [],
          dataDirectory: `/srv/kiln/apps/${String(payload.id)}`,
          deployment: null,
          hostname: `app-${String(payload.id).slice(0, 8)}`,
          id: payload.id,
          network: `kiln-app-${String(payload.id).slice(0, 8)}`,
          observedState: "provisioning",
          savedDatabaseIds: [],
          shortId: String(payload.id).slice(0, 8),
          status: "Waiting for Hearth",
        }
      case "database.provision.prepare":
        relay.jobs.push(String(payload.id))
        return {
          containerId: null,
          createdAt: new Date(0).toISOString(),
          databaseName: payload.databaseName,
          engine: payload.engine,
          hostname: `database-${String(payload.id)}`,
          id: payload.id,
          image: "postgres:17",
          internalPort: 5432,
          members: [],
          name: payload.name,
          observedState: "provisioning",
          shortId: String(payload.id).slice(0, 8),
          status: "Waiting for Hearth",
          supportsImportExport: true,
        }
      default:
        return {}
    }
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))
vi.mock("@/server/web-hostname-access.server", () => ({
  generateAppHostnameBestEffort: () => Promise.resolve(),
}))

import {
  createAppOperation,
  withNewAppIds,
  type CreateAppInput,
} from "./app-create.server"

const relayId = "r".repeat(43)
const otherRelayId = "s".repeat(43)
const database = "d".repeat(40)

const person = (id: string): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id,
  isDevelopmentBypass: false,
  name: id,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
})

const allow = (
  userId: string,
  permissions: ReadonlyArray<AccessPermission>,
  relay = relayId
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId: relay,
      resourceId: relay,
      resourceType: "relay",
      state: "active",
      userId,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
  })

// Bob's, so that all alice may do with it is what the grant gives.
const seedDatabase = (id: string, relay: string, name: string) =>
  createManagedDatabaseRecordEffect({
    createdBy: "bob",
    databaseId: id,
    databaseName: "kiln_main",
    engine: "postgres",
    name,
    password: "the-password",
    relayId: relay,
    username: "kiln_user",
  })

const seed = (permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    yield* resetDatabase
    relay.connections.clear()
    relay.jobs.length = 0
    yield* insertRelay(relayId, { enabled: 1 })
    yield* insertUser("alice")
    yield* insertUser("bob")
    yield* allow("alice", permissions)
    yield* seedDatabase(database, relayId, "Shared")
  })

const createApp = (
  input: Pick<CreateAppInput, "database"> & { name?: string }
) =>
  runOperation(
    createAppOperation,
    withNewAppIds({ name: "Blog", relayId, ...input }),
    { user: person("alice") }
  )

const apps = selectRows<{ app_id: string }>("app")

describeMysql("Creating an App with a database", () => {
  layer(TestDatabase)((it) => {
    it.effect("connects a new database, with its credentials to hand", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.create"])

        const created = yield* createApp({
          database: { engine: "postgres", kind: "new", name: "Blog" },
        })

        const [saved] = relay.connections.get(created.id)!
        assert.isDefined(saved)
        const credential = yield* loadManagedDatabaseCredentialEffect(
          relayId,
          saved!
        )
        const app = yield* loadAppConfigEffect(relayId, created.id)
        assert.strictEqual(
          app?.config.environment,
          [
            `DB_HOST=database-${saved}`,
            "DB_PORT=5432",
            `DB_USER=${credential!.username}`,
            `DB_PASS=${credential!.password}`,
            `DB_NAME=${credential!.databaseName}`,
            "",
          ].join("\n")
        )
      })
    )

    it.effect("gives a new database the names chosen for it", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.create"])

        const created = yield* createApp({
          database: {
            databaseName: "blog_data",
            engine: "postgres",
            kind: "new",
            name: "Blog",
            username: "blog_owner",
          },
        })

        const [saved] = relay.connections.get(created.id)!
        const credential = yield* loadManagedDatabaseCredentialEffect(
          relayId,
          saved!
        )
        assert.strictEqual(credential?.databaseName, "blog_data")
        assert.strictEqual(credential?.username, "blog_owner")
        const app = yield* loadAppConfigEffect(relayId, created.id)
        assert.include(app?.config.environment, "DB_USER=blog_owner")
        assert.include(app?.config.environment, "DB_NAME=blog_data")
      })
    )

    it.effect("creates a database with the name and username it's given", () =>
      Effect.gen(function* () {
        yield* seed(["database.create"])

        const created = yield* runOperation(
          createDatabase,
          {
            databaseName: "shop_data",
            engine: "postgres",
            name: "Shop",
            relayId,
            username: "shop_owner",
          },
          { user: person("alice") }
        )

        const credential = yield* loadManagedDatabaseCredentialEffect(
          relayId,
          created.id
        )
        assert.strictEqual(credential?.databaseName, "shop_data")
        assert.strictEqual(credential?.username, "shop_owner")
      })
    )

    it.effect("records no database for a username its engine keeps", () =>
      Effect.gen(function* () {
        yield* seed(["database.create"])

        const error = yield* runOperation(
          createDatabase,
          { engine: "mysql", name: "Shop", relayId, username: "root" },
          { user: person("alice") }
        ).pipe(Effect.flip)

        assert.include(String(error), "reserved")
        assert.deepStrictEqual(relay.jobs, [])
        const rows = yield* selectRows<{ name: string }>("database")
        assert.deepStrictEqual(
          rows.map((row) => row.name),
          ["Shared"]
        )
      })
    )

    it.effect("copies an existing database's credentials", () =>
      Effect.gen(function* () {
        yield* seed([
          "app.create",
          "database.credentials.read",
          "database.network.write",
        ])

        const created = yield* createApp({
          database: { id: database, kind: "existing" },
        })

        assert.deepStrictEqual(relay.connections.get(created.id), [database])
        const app = yield* loadAppConfigEffect(relayId, created.id)
        assert.include(app?.config.environment, "DB_PASS=the-password\n")
      })
    )

    it.effect("creates several Apps on one database at once", () =>
      Effect.gen(function* () {
        yield* seed([
          "app.create",
          "database.credentials.read",
          "database.network.write",
        ])

        // They take the database's connections in turn, so all but the
        // first wait for it.
        const names = ["One", "Two", "Three", "Four", "Five", "Six"]
        const created = yield* Effect.all(
          names.map((name) =>
            createApp({ database: { id: database, kind: "existing" }, name })
          ),
          { concurrency: "unbounded" }
        )

        assert.strictEqual(new Set(created.map(({ id }) => id)).size, 6)
        for (const { id } of created) {
          assert.deepStrictEqual(relay.connections.get(id), [database])
        }
      })
    )

    it.effect("won't copy credentials someone can't read", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.network.write"])

        const refused = yield* createApp({
          database: { id: database, kind: "existing" },
        }).pipe(Effect.flip)

        assert.isDefined(refused)
        assert.deepStrictEqual(yield* apps, [])
        assert.deepStrictEqual(relay.jobs, [])
      })
    )

    it.effect("won't connect a database someone can't change", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.credentials.read"])

        yield* createApp({
          database: { id: database, kind: "existing" },
        }).pipe(Effect.flip)

        assert.deepStrictEqual(yield* apps, [])
        assert.deepStrictEqual(relay.jobs, [])
      })
    )

    it.effect("won't reach a database on another Relay", () =>
      Effect.gen(function* () {
        yield* seed([
          "app.create",
          "database.credentials.read",
          "database.network.write",
        ])
        const elsewhere = "e".repeat(40)
        yield* insertRelay(otherRelayId, { enabled: 1 })
        yield* seedDatabase(elsewhere, otherRelayId, "Elsewhere")

        yield* createApp({
          database: { id: elsewhere, kind: "existing" },
        }).pipe(Effect.flip)

        assert.deepStrictEqual(yield* apps, [])
        assert.deepStrictEqual(relay.jobs, [])
      })
    )

    it.effect("makes neither when the database can't be made", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.create"])

        const refused = yield* createApp({
          database: { engine: "postgres", kind: "new", name: "Shared" },
        }).pipe(Effect.flip)

        assert.include(String(refused), "already exists")
        assert.deepStrictEqual(yield* apps, [])
        assert.deepStrictEqual(relay.jobs, [])
      })
    )

    it.effect("makes no database when the App's name is taken", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.create"])
        yield* createApp({})
        relay.jobs.length = 0

        yield* createApp({
          database: { engine: "postgres", kind: "new", name: "Blog" },
        }).pipe(Effect.flip)

        assert.deepStrictEqual(relay.jobs, [])
      })
    )
  })
})
