import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { loadAppConfigEffect } from "@/effect/managed-apps"
import { createManagedDatabaseRecordEffect } from "@/effect/managed-databases"
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
  cancelled: [] as Array<string>,
  connections: new Map<string, ReadonlyArray<string>>(),
  jobs: [] as Array<string>,
}))
// Hearth's own database failing partway through, for one write.
const hearth = vi.hoisted(() => ({ losesImageWrite: false }))

vi.mock("@/lib/relay-connection", () => ({
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: Record<string, unknown> & {
      databaseIds?: Array<string>
      recipeDefinition?: { type?: string }
    }
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
          hostname: `app-${String(payload.id)}`,
          id: payload.id,
          network: `kiln-app-${String(payload.id)}`,
          observedState: "provisioning",
          savedDatabaseIds: [],
          status: "Waiting for Hearth",
        }
      case "database.provision.prepare":
        relay.jobs.push(String(payload.id))
        return {
          containerId: null,
          createdAt: new Date(0).toISOString(),
          databaseName: payload.databaseName,
          engine: payload.recipeDefinition?.type,
          hostname: `database-${String(payload.id)}`,
          id: payload.id,
          image: "postgres:17",
          internalPort: 5432,
          members: [],
          name: payload.name,
          observedState: "provisioning",
          status: "Waiting for Hearth",
          supportsImportExport: true,
        }
      case "database.provision.cancel":
        relay.cancelled.push(String(payload.databaseId))
        return { cancelled: true }
      default:
        return {}
    }
  },
}))
// Hearth's `Database` service over real MySQL, which loses that one write
// when asked to.
vi.mock("@/effect/database", async (original) => {
  const actual = await original<typeof import("@/effect/database")>()
  const { Effect, Layer } = await import("effect")
  const { DatabaseError } = await import("@/effect/errors")
  const lossy = Layer.effect(actual.Database)(
    Effect.map(actual.Database, (database) => ({
      ...database,
      execute: ((operation, statement, values) =>
        hearth.losesImageWrite && operation === "managed_database_set_image"
          ? Effect.fail(
              DatabaseError.make({
                operation,
                cause: new Error("Lost connection to MySQL server"),
              })
            )
          : database.execute(
              operation,
              statement,
              values
            )) satisfies typeof database.execute,
    }))
  )
  return {
    ...actual,
    DatabaseLive: lossy.pipe(Layer.provideMerge(actual.DatabaseLive)),
  }
})
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))
// Catalogs are fetched over the network. This is Kiln's own, with its
// Bricks as the repository has them.
vi.mock("@/server/brick-catalogs.server", async () => {
  const { readFileSync } = await import("node:fs")
  const { parse } = await import("yaml")
  const { brickSchema } = await import("@workspace/contracts")
  const bricks = ["mysql", "postgres", "docker-image", "compose"].map((id) =>
    brickSchema.parse({
      ...parse(
        readFileSync(
          new URL(`../../../bricks/bricks/${id}.yml`, import.meta.url),
          "utf8"
        )
      ),
      source: `https://bricks.test/${id}.yml`,
    })
  )
  // An App Brick that sets its own variables, one a secret Kiln makes.
  const blog = brickSchema.parse({
    format: "kiln.brick/v2",
    kind: "app",
    metadata: {
      id: "blog",
      name: "Blog",
      summary: "An example.",
      author: "Kiln",
    },
    inputs: [
      { key: "mode", label: "Mode", type: "text", default: "production" },
      { key: "key", label: "Key", type: "secret", generate: true },
    ],
    deploy: {
      type: "image",
      image: "ghcr.io/acme/blog:1",
      env: { MODE: "{{ mode }}", SECRET_KEY: "{{ key }}" },
    },
    source: "https://bricks.test/blog.yml",
  })
  // An App Brick that publishes a port on its Relay.
  const mail = brickSchema.parse({
    format: "kiln.brick/v2",
    kind: "app",
    metadata: {
      id: "mail",
      name: "Mail",
      summary: "An example.",
      author: "Kiln",
    },
    deploy: {
      type: "image",
      image: "ghcr.io/acme/mail:1",
      ports: [{ name: "smtp", port: 25, expose: "public", host: 2525 }],
    },
    source: "https://bricks.test/mail.yml",
  })
  return {
    defaultBrickCatalog: async () => ({ bricks: [...bricks, blog, mail] }),
  }
})
vi.mock("@/server/web-hostname-access.server", () => ({
  generateAppHostnameBestEffort: () => Promise.resolve(),
}))

import {
  createAppFor,
  createAppOperation,
  withNewAppIdsEffect,
  type CreateAppInput,
} from "./app-create.server"

const relayId = "1".repeat(12)
const otherRelayId = "2".repeat(12)
const database = "d".repeat(12)

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
    brickId: "postgres",
    brickSource: "https://bricks.test/postgres.yml",
    createdBy: "bob",
    databaseId: id,
    databaseName: "kiln_main",
    engine: "postgres",
    internalPort: 5432,
    name,
    password: "the-password",
    relayId: relay,
    username: "kiln_user",
  })

const seed = (permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    yield* resetDatabase
    relay.cancelled.length = 0
    relay.connections.clear()
    relay.jobs.length = 0
    hearth.losesImageWrite = false
    yield* insertRelay(relayId, { enabled: 1 })
    yield* insertUser("alice")
    yield* insertUser("bob")
    yield* allow("alice", permissions)
    yield* seedDatabase(database, relayId, "Shared")
  })

const createApp = (
  input: Partial<Pick<CreateAppInput, "brick" | "database" | "variables">> & {
    name?: string
  }
) =>
  withNewAppIdsEffect(
    {
      brick: "https://bricks.test/compose.yml",
      idempotencyKey: crypto.randomUUID(),
      name: "Blog",
      relayId,
      ...input,
    },
    "alice"
  ).pipe(
    Effect.flatMap((ids) =>
      runOperation(createAppOperation, ids, { user: person("alice") })
    )
  )

const apps = selectRows<{ app_id: string }>("app")

describeMysql("Creating an App with a database", () => {
  layer(TestDatabase)((it) => {
    it.effect("records no database for a username its engine keeps", () =>
      Effect.gen(function* () {
        yield* seed(["database.create"])

        const error = yield* runOperation(
          createDatabase,
          {
            brick: "https://bricks.test/mysql.yml",
            id: "e".repeat(12),
            name: "Shop",
            relayId,
            username: "root",
          },
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

    // The Relay holds a job by then. Left unclaimed, it would keep the
    // name, and the database could only be deleted and made again.
    it.effect(
      "undoes a database it couldn't finish recording, so it can be tried again",
      () =>
        Effect.gen(function* () {
          yield* seed(["database.create"])
          const create = (id: string) =>
            runOperation(
              createDatabase,
              {
                brick: "https://bricks.test/postgres.yml",
                id,
                name: "Shop",
                relayId,
              },
              { user: person("alice") }
            )

          hearth.losesImageWrite = true
          yield* create("e".repeat(12)).pipe(Effect.flip)

          assert.deepStrictEqual(relay.cancelled, ["e".repeat(12)])
          const names = selectRows<{ name: string }>("database").pipe(
            Effect.map((rows) => rows.map((row) => row.name).sort())
          )
          assert.deepStrictEqual(yield* names, ["Shared"])

          hearth.losesImageWrite = false
          yield* create("a".repeat(12))
          assert.deepStrictEqual(yield* names, ["Shared", "Shop"])
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
        const elsewhere = "f".repeat(12)
        yield* insertRelay(otherRelayId, { enabled: 1 })
        yield* seedDatabase(elsewhere, otherRelayId, "Elsewhere")

        yield* createApp({
          database: { id: elsewhere, kind: "existing" },
        }).pipe(Effect.flip)

        assert.deepStrictEqual(yield* apps, [])
        assert.deepStrictEqual(relay.jobs, [])
      })
    )

    it.effect(
      "installs what its Brick deploys, and nothing from a Brick or answers it can't install",
      () =>
        Effect.gen(function* () {
          yield* seed(["app.create"])
          const image = "https://bricks.test/docker-image.yml"

          const created = yield* createApp({
            brick: image,
            variables: { image: "ghcr.io/acme/site:1" },
          })

          const saved = yield* loadAppConfigEffect(relayId, created.id)
          assert.strictEqual(saved?.config.sourceType, "image")
          assert.strictEqual(saved?.config.image, "ghcr.io/acme/site:1")
          assert.isTrue(created.deployable)
          // One of Kiln's generic Bricks: the App is its owner's, and
          // follows nothing.
          assert.isNull(saved?.brick)

          // A catalog Brick sets its variables, makes its secret once, and
          // is kept, with its answers, to be followed.
          const blog = yield* createApp({
            brick: "https://bricks.test/blog.yml",
            name: "Journal",
          })
          const followed = yield* loadAppConfigEffect(relayId, blog.id)
          const secret = String(followed?.brick?.answers.key)
          assert.match(secret, /^[\w-]{32}$/u)
          assert.strictEqual(
            followed?.config.environment,
            `MODE=production\nSECRET_KEY=${secret}\n`
          )
          // Its answers are kept as they stood, a default among them, so
          // a later revision's other default doesn't change this App.
          assert.deepStrictEqual(followed?.brick, {
            answers: { key: secret, mode: "production" },
            environment: ["MODE", "SECRET_KEY"],
            name: "Blog",
            revision: 1,
            source: "https://bricks.test/blog.yml",
            volumes: [],
          })

          for (const refused of [
            // Another kind's Brick, one from no catalog of Kiln's, and one
            // with the answer it needs left out.
            { brick: "https://bricks.test/postgres.yml" },
            { brick: "https://elsewhere.test/docker-image.yml" },
            { brick: image },
            { brick: image, variables: { image: "nginx:1", command: "sh" } },
          ]) {
            yield* createApp({ ...refused, name: "Other" }).pipe(Effect.flip)
          }
          assert.deepStrictEqual(
            (yield* apps).map((app) => app.app_id).sort(),
            [created.id, blog.id].sort()
          )
          assert.deepStrictEqual(relay.jobs, [created.id, blog.id])
        })
    )

    // A port published on the Relay is reachable by anyone who can reach
    // the Relay. Publishing one in an App's settings takes `app.manage`,
    // so installing a Brick that publishes one takes it too.
    it.effect(
      "won't install a Brick that publishes a port for someone who may only create Apps",
      () =>
        Effect.gen(function* () {
          yield* seed(["app.create"])
          const mail = { brick: "https://bricks.test/mail.yml", name: "Mail" }

          const refused = yield* createApp(mail).pipe(Effect.flip)
          assert.include(String(refused), "permission")
          assert.lengthOf(yield* apps, 0)

          yield* seed(["app.create", "app.manage"])
          yield* createApp(mail)
          assert.lengthOf(yield* apps, 1)
        })
    )

    // Deploying is its own permission: creating an App doesn't carry it.
    it.effect(
      "leaves an App its creator may not deploy created, and says why it wasn't deployed",
      () =>
        Effect.gen(function* () {
          yield* seed(["app.create"])

          const created = yield* Effect.promise(() =>
            createAppFor(person("alice"), {
              brick: "https://bricks.test/docker-image.yml",
              idempotencyKey: crypto.randomUUID(),
              name: "Blog",
              relayId,
              variables: { image: "ghcr.io/acme/site:1" },
            })
          )

          assert.include(created.deployError, "permission")
          assert.deepStrictEqual(
            (yield* apps).map((app) => app.app_id),
            [created.id]
          )
        })
    )

    it.effect("makes neither when the database can't be made", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.create"])

        const refused = yield* createApp({
          database: {
            brick: "https://bricks.test/postgres.yml",
            kind: "new",
            name: "Shared",
          },
        }).pipe(Effect.flip)

        assert.include(String(refused), "already exists")
        assert.deepStrictEqual(yield* apps, [])
        assert.deepStrictEqual(relay.jobs, [])
      })
    )
  })
})
