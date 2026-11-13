import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import type { AppMount } from "@workspace/contracts"
import { relayCatalogSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { saveBrickCatalogEffect } from "@/effect/brick-catalogs"
import {
  instanceGroupOfEffect,
  changeInstanceGroupBrickEffect,
} from "@/effect/instance-groups"
import {
  detachAppBrickEffect,
  loadAppConfigEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
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
// each new instance's job in the order they were asked for, the databases
// an App's job would connect it to, the volumes it was asked to make, and
// which of them each App's configuration names.
const relay = vi.hoisted(() => ({
  connections: new Map<string, ReadonlyArray<string>>(),
  jobs: [] as Array<string>,
  // Each App's volumes as they stood when its job was asked for.
  mounted: new Map<string, ReadonlyArray<string>>(),
  named: new Map<string, ReadonlyArray<string>>(),
  volumes: new Map<string, string>(),
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
      volumeIds?: Array<string>
    }
  ) => {
    switch (operation) {
      case "relay.volumes.create":
        relay.volumes.set(String(payload.id), String(payload.name))
        return {
          createdAt: null,
          dockerName: `kiln-${String(payload.id).slice(0, 8)}`,
          id: payload.id,
          kind: "kiln",
          mountpoint: null,
          mounts: [],
          name: payload.name,
          owner: null,
          sizeBytes: null,
          users: [],
        }
      // As a Relay does, it names only volumes it has.
      case "app.volumes.write":
        if ((payload.volumeIds ?? []).some((id) => !relay.volumes.has(id))) {
          throw new Error("A volume it mounts no longer exists")
        }
        relay.named.set(String(payload.appId), payload.volumeIds ?? [])
        return {}
      case "app.provision.prepare":
        if (relay.refusesApps) throw new Error("The Relay is out of room")
        relay.jobs.push(`app:${String(payload.id)}`)
        relay.connections.set(String(payload.id), payload.databaseIds ?? [])
        relay.mounted.set(
          String(payload.id),
          relay.named.get(String(payload.id)) ?? []
        )
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
            volumes: ["/data"],
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
    relay.mounted.clear()
    relay.named.clear()
    relay.volumes.clear()
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
            volumes: ["/data"],
          })
          const group = yield* instanceGroupOfEffect(app?.id ?? "")
          assert.strictEqual(group?.name, "Stats")
          // The group keeps its answers and what its database was made
          // from, which a later revision is held to.
          const kept = yield* changeInstanceGroupBrickEffect(
            group?.id ?? "",
            (keep) => Effect.succeed({ keep, made: keep })
          )
          assert.match(String(kept?.answers.key), /^[\w-]{32}$/u)
          assert.deepStrictEqual(kept?.databases, {
            database: { brick: "postgres", variables: {} },
          })
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

    // What an App writes there has to outlast its containers from its
    // first deployment on, and go on doing so while it follows the Brick.
    it.effect(
      "keeps each folder its Brick names on a volume made before the App is, held while it follows the Brick",
      () =>
        Effect.gen(function* () {
          yield* seed(["app.create", "database.create"])

          const { created } = yield* install()

          const appId = created?.apps[0]?.id ?? ""
          const volumeId = [...relay.volumes.keys()][0] ?? ""
          assert.strictEqual(relay.volumes.get(volumeId), "Stats data")
          // Its Relay had the volume, named as the App's, before the App.
          assert.deepStrictEqual(relay.mounted.get(appId), [volumeId])
          const mounts = () =>
            Effect.map(
              loadAppConfigEffect(relayId, appId),
              (app) => app?.config.mounts ?? []
            )
          const [mount] = yield* mounts()
          assert.deepInclude(mount, {
            readOnly: false,
            source: { type: "volume", volumeId },
            target: "/data",
          })

          const saves = (change: (kept: AppMount) => Array<AppMount>) =>
            updateAppConfigEffect(relayId, appId, (config) => ({
              ...config,
              mounts: change(mount!),
            })).pipe(
              Effect.as(null),
              Effect.catch((cause) => Effect.succeed(String(cause)))
            )
          // Unmounted, read-only, or a path on the node in its place, the
          // folder would no longer be kept.
          for (const unkept of [
            () => [],
            (kept: AppMount) => [{ ...kept, readOnly: true }],
            (kept: AppMount) => [{ ...kept, target: "/elsewhere" }],
            // An image runs one container: a mount for another service
            // is mounted nowhere.
            (kept: AppMount) => [{ ...kept, service: "other" }],
            (kept: AppMount) => [
              { ...kept, source: { path: "/srv/data", type: "host" as const } },
            ],
          ]) {
            assert.include(
              yield* saves(unkept),
              "The volume at /data is set by its Brick, Analytics"
            )
          }
          // Which volume keeps it is its owner's to say, as is whatever
          // else it mounts.
          const other = "b".repeat(40)
          relay.volumes.set(other, "Restored")
          assert.isNull(
            yield* saves((kept) => [
              { ...kept, source: { type: "volume", volumeId: other } },
              { ...kept, id: "ownmount01", target: "/cache" },
            ])
          )
          assert.lengthOf(yield* mounts(), 2)
          // Detached, nothing of it is the Brick's.
          yield* detachAppBrickEffect(relayId, appId)
          assert.isNull(yield* saves(() => []))
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
        // The volume made for the App stays, empty, and its Relay is told
        // no App names it any more, so nothing keeps it from being deleted.
        assert.strictEqual(relay.volumes.size, 1)
        assert.deepStrictEqual([...relay.named.values()], [[]])
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

    // A group in someone else's catalog brings its Apps; a database it
    // names is still one of Kiln's own, by its ID.
    it.effect(
      "installs one from a catalog its installer sees, with Kiln's own database Brick",
      () =>
        Effect.gen(function* () {
          const read = "b".repeat(40)
          const billys = `https://raw.githubusercontent.com/billy/bricks/${read}/wiki.yml`
          const addCatalog = (owner: string) =>
            saveBrickCatalogEffect({
              ownerUserId: owner,
              revisionSha: read,
              revisionUrl: `https://github.com/billy/bricks/blob/${read}/catalog.yml`,
              snapshot: relayCatalogSchema.parse({
                format: "kiln.catalog/v1",
                name: "Billy's",
                bricks: [
                  {
                    format: "kiln.brick/v2",
                    kind: "group",
                    metadata: {
                      id: "wiki",
                      name: "Wiki",
                      summary: "An example.",
                      author: "Billy",
                    },
                    group: {
                      members: {
                        database: { brick: "postgres" },
                        web: {
                          kind: "app",
                          deploy: {
                            type: "image",
                            image: "ghcr.io/billy/wiki:1",
                          },
                          connect: {
                            database: { DATABASE_URL: "{{ connection }}" },
                          },
                        },
                      },
                    },
                    source: billys,
                  },
                ],
              }),
              snapshotSha256: "0".repeat(64),
              source: "https://github.com/billy/bricks",
            })
          const installBillys = Effect.promise(() =>
            createInstanceGroupFor(person("alice"), {
              brick: billys,
              idempotencyKey: crypto.randomUUID(),
              name: "Wiki",
              relayId,
            }).then(
              (created) => ({ created, refused: null }),
              (refused: unknown) => ({
                created: null,
                refused: String(refused),
              })
            )
          )

          // In a catalog only someone else sees, it isn't hers to install.
          yield* seed(["app.create", "database.create"])
          yield* insertUser("bob")
          yield* addCatalog("bob")
          assert.include((yield* installBillys).refused, "in your catalogs")
          assert.deepStrictEqual(relay.jobs, [])

          yield* seed(["app.create", "database.create"])
          yield* addCatalog("alice")
          const { created } = yield* installBillys
          const [app] = created?.apps ?? []
          const config = yield* loadAppConfigEffect(relayId, app?.id ?? "")
          assert.strictEqual(config?.config.image, "ghcr.io/billy/wiki:1")
          assert.strictEqual(config?.brick?.source, billys)
          // Its database is Kiln's PostgreSQL Brick's.
          assert.strictEqual(yield* count("database"), 1)
          assert.match(
            config?.config.environment ?? "",
            /^DATABASE_URL=postgresql:\/\//u
          )
        })
    )
  })
})
