import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { instanceGroupOfEffect } from "@/effect/instance-groups"
import { loadAppConfigEffect } from "@/effect/managed-apps"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
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
// each new instance's job in the order they were asked for, and the
// databases an App's job would connect it to.
const relay = vi.hoisted(() => ({
  connections: new Map<string, ReadonlyArray<string>>(),
  jobs: [] as Array<string>,
  // The Relay turning a new App away.
  refusesApps: false,
  // The kind whose claim, and the cancel after it, never get an answer.
  silentAbout: null as "app" | "database" | null,
}))

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
        if (relay.refusesApps) throw new Error("The Relay is out of room")
        relay.jobs.push(`app:${String(payload.id)}`)
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
        relay.jobs.push(`database:${String(payload.id)}`)
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
      case "app.provision.claim":
      case "app.provision.cancel":
        if (relay.silentAbout === "app") throw new Error("No answer")
        return { cancelled: true }
      case "database.provision.claim":
      case "database.provision.cancel":
        if (relay.silentAbout === "database") throw new Error("No answer")
        return { cancelled: true }
      default:
        return {}
    }
  },
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))
// Catalogs are fetched over the network. This is Kiln's own, with its
// PostgreSQL Brick as the repository has it and a group that uses it.
vi.mock("@/server/brick-catalogs.server", async () => {
  const { readFileSync } = await import("node:fs")
  const { parse } = await import("yaml")
  const { brickSchema } = await import("@workspace/contracts")
  const postgres = brickSchema.parse({
    ...parse(
      readFileSync(
        new URL("../../../bricks/bricks/postgres.yml", import.meta.url),
        "utf8"
      )
    ),
    source: "https://bricks.test/postgres.yml",
  })
  const analytics = brickSchema.parse({
    format: "kiln.brick/v2",
    kind: "group",
    metadata: {
      id: "analytics",
      name: "Analytics",
      summary: "An App with a database of its own.",
      author: "Kiln",
    },
    inputs: [{ key: "key", label: "Key", type: "secret", generate: true }],
    group: {
      members: {
        database: { brick: "postgres" },
        web: {
          kind: "app",
          deploy: {
            type: "image",
            image: "ghcr.io/acme/analytics:1",
            env: { SECRET_KEY: "{{ key }}" },
          },
          connect: { database: { DATABASE_URL: "{{ connection }}" } },
        },
      },
    },
    source: "https://bricks.test/analytics.yml",
  })
  return {
    defaultBrickCatalog: async () => ({ bricks: [postgres, analytics] }),
  }
})
vi.mock("@/server/web-hostname-access.server", () => ({
  generateAppHostnameBestEffort: () => Promise.resolve(),
}))

import { createInstanceGroupFor } from "./instance-group-create.server"

const relayId = "1".repeat(12)

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

const seed = (permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    yield* resetDatabase
    relay.connections.clear()
    relay.jobs.length = 0
    relay.refusesApps = false
    relay.silentAbout = null
    yield* insertRelay(relayId, { enabled: 1 })
    yield* insertUser("alice")
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: relayId,
      resourceType: "relay",
      state: "active",
      userId: "alice",
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

const install = (name = "Stats") =>
  Effect.promise(() =>
    createInstanceGroupFor(person("alice"), {
      brick: "https://bricks.test/analytics.yml",
      idempotencyKey: crypto.randomUUID(),
      name,
      relayId,
    }).then(
      (created) => ({ created, refused: null }),
      (refused: unknown) => ({ created: null, refused: String(refused) })
    )
  )

const count = (table: string) =>
  Effect.map(selectRows(table), (rows) => rows.length)
const databases = selectRows<{ database_id: string; name: string }>("database")

describeMysql("Installing a group Brick", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "makes its database, then its App connected to it, and keeps them together",
      () =>
        Effect.gen(function* () {
          yield* seed(["app.create", "database.create"])

          const { created } = yield* install()

          assert.isNotNull(created)
          const [database] = created?.databases ?? []
          const [app] = created?.apps ?? []
          assert.deepStrictEqual(relay.jobs, [
            `database:${database?.id}`,
            `app:${app?.id}`,
          ])
          assert.deepStrictEqual(relay.connections.get(app?.id ?? ""), [
            database?.id,
          ])
          // What it reaches its database by is in its environment from the
          // start, at the name its Relay gives the database.
          const config = yield* loadAppConfigEffect(relayId, app?.id ?? "")
          assert.strictEqual(config?.config.image, "ghcr.io/acme/analytics:1")
          // A secret Kiln made for it is there too.
          assert.match(
            config?.config.environment ?? "",
            new RegExp(
              `^SECRET_KEY=[\\w-]{32}\\nDATABASE_URL=postgresql://[^:]+:[^@]+@database-${database?.id}:5432/[^\\n]+\\n$`,
              "u"
            )
          )
          // What it keeps of its Brick, to be offered its revisions: the
          // App follows the group's Brick as its `web`, with the variables
          // the Brick set as the Brick's.
          assert.deepStrictEqual(config?.brick, {
            answers: {},
            connect: ["database"],
            environment: ["SECRET_KEY", "DATABASE_URL"],
            member: "web",
            name: "Analytics",
            revision: 1,
            source: "https://bricks.test/analytics.yml",
          })
          const group = yield* instanceGroupOfEffect(app?.id ?? "")
          assert.strictEqual(group?.name, "Stats")
          assert.deepStrictEqual(
            group?.members.map((member) => member.member),
            ["web", "database"]
          )
          assert.deepStrictEqual(
            group?.members.map((member) => member.instanceId),
            [app?.id, database?.id]
          )
        })
    )

    // Its database is real by then: it stays, in the group, for whoever
    // installed it to keep or delete.
    it.effect("keeps what it made when a later member can't be made", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.create"])
        relay.refusesApps = true

        const { refused } = yield* install()

        assert.include(refused, "out of room")
        const [database] = yield* databases
        assert.strictEqual(database?.name, "Stats")
        assert.strictEqual(yield* count("app"), 0)
        const group = yield* instanceGroupOfEffect(database?.database_id ?? "")
        assert.deepStrictEqual(
          group?.members.map((member) => member.instanceId),
          [database?.database_id]
        )
      })
    )

    // Hearth keeps the record of a member whose Relay never said whether it
    // took the job or let go of it: it may be running. Left out of the
    // group, deleting the group couldn't reach it.
    it.effect("keeps in the group a member it can't be sure wasn't made", () =>
      Effect.gen(function* () {
        yield* seed(["app.create", "database.create"])

        relay.silentAbout = "app"
        const app = yield* install()
        assert.include(app.refused, "could not confirm")
        const [made] = yield* selectRows<{ app_id: string }>("app")
        const [database] = yield* databases
        assert.deepStrictEqual(
          (yield* instanceGroupOfEffect(made?.app_id ?? ""))?.members.map(
            (member) => member.instanceId
          ),
          [made?.app_id, database?.database_id]
        )

        // The first member too, which would otherwise leave no group.
        yield* seed(["app.create", "database.create"])
        relay.silentAbout = "database"
        yield* install()
        const [kept] = yield* databases
        assert.deepStrictEqual(
          (yield* instanceGroupOfEffect(kept?.database_id ?? ""))?.members.map(
            (member) => member.instanceId
          ),
          [kept?.database_id]
        )
        assert.strictEqual(yield* count("app"), 0)
      })
    )

    it.effect(
      "makes nothing for someone who may not make every member, or under a name that's taken",
      () =>
        Effect.gen(function* () {
          // Creating an App doesn't carry creating its database.
          yield* seed(["app.create"])
          const { refused } = yield* install()
          assert.include(refused, "permission")
          assert.deepStrictEqual(relay.jobs, [])
          assert.strictEqual(yield* count("instance_group"), 0)

          yield* seed(["app.create", "database.create"])
          yield* install()
          relay.jobs.length = 0
          const again = yield* install()
          assert.include(again.refused, "already exists")
          assert.deepStrictEqual(relay.jobs, [])
          assert.strictEqual(yield* count("instance_group"), 1)
          assert.strictEqual(yield* count("database"), 1)
        })
    )
  })
})
