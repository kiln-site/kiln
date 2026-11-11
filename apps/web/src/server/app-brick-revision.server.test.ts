import { assert, layer } from "@effect/vitest"
import { brickRecipeSchema, type BrickRecipe } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import {
  addInstanceGroupMemberEffect,
  createInstanceGroupEffect,
} from "@/effect/instance-groups"
import {
  createAppRecordEffect,
  detachAppBrickEffect,
  loadAppConfigEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import {
  createManagedDatabaseRecordEffect,
  rotateManagedDatabaseCredentialEffect,
} from "@/effect/managed-databases"
import { disposeAppRuntime } from "@/effect/runtime"
import type { PersistedRelay } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

// The App's deployment queue is the boundary: it keeps what was asked of it.
const queue = vi.hoisted(() => ({
  asked: [] as Array<Record<string, unknown>>,
}))
vi.mock("@/lib/app-deployments.server", async () => {
  const { Effect } = await import("effect")
  return {
    askAppDeploymentEffect: (ask: Record<string, unknown>) =>
      Effect.sync(() => {
        queue.asked.push(ask)
      }),
  }
})
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

import { installAppBrickRevision } from "./app-brick-revision.server"

const relayId = "1".repeat(12)
const relay = { id: relayId, name: "Node" } as PersistedRelay
const appId = "a".repeat(12)
const workerId = "b".repeat(12)
const databaseId = "d".repeat(12)
const groupId = "9".repeat(12)

const metadata = { summary: "An example.", author: "Kiln" }
const newest = (definition: BrickRecipe, revision = 2) => ({
  definition,
  name: definition.metadata.name,
  revision,
  source: `https://bricks.test/${definition.metadata.id}.yml`,
})
const install = (definition: BrickRecipe, revision = 2, of = appId) =>
  Effect.promise(() =>
    installAppBrickRevision(relay, of, newest(definition, revision), {
      userId: "owner",
    }).then(
      () => null,
      (refused: unknown) => String(refused)
    )
  )
const savedOf = (of: string) =>
  Effect.map(loadAppConfigEffect(relayId, of), (app) => app!)
const saved = savedOf(appId)

const seed = Effect.gen(function* () {
  yield* resetDatabase
  queue.asked.length = 0
  yield* insertRelay(relayId, { enabled: 1 })
  yield* insertUser("owner")
})

// Revision 2 of a Blog: another image, a variable dropped, a secret added.
const blog = brickRecipeSchema.parse({
  format: "kiln.brick/v2",
  kind: "app",
  metadata: { ...metadata, id: "blog", name: "Blog", revision: 2 },
  inputs: [
    { key: "key", label: "Key", type: "secret", generate: true },
    { key: "token", label: "Token", type: "secret", generate: true },
    { key: "region", label: "Region", type: "text", default: "eu" },
  ],
  deploy: {
    type: "image",
    image: "ghcr.io/acme/blog:2",
    env: { SECRET_KEY: "{{ key }}", API_TOKEN: "{{ token }}" },
  },
})

const analytics = (members: Record<string, unknown>) =>
  brickRecipeSchema.parse({
    format: "kiln.brick/v2",
    kind: "group",
    metadata: { ...metadata, id: "analytics", name: "Analytics", revision: 2 },
    inputs: [{ key: "key", label: "Key", type: "secret", generate: true }],
    group: { members },
  })
const web = {
  kind: "app",
  deploy: {
    type: "image",
    image: "ghcr.io/acme/analytics:2",
    env: { SECRET_KEY: "{{ key }}", MODE: "production" },
  },
  connect: { database: { DATABASE_URL: "{{ connection }}" } },
}

describeMysql("An App taking a newer revision of its Brick", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "is made again from its answers, keeping what its owner added",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* createAppRecordEffect({
            appId,
            brick: {
              answers: { key: "made-once", mode: "review" },
              environment: ["MODE", "SECRET_KEY"],
              name: "Blog",
              revision: 1,
              source: "https://bricks.test/blog.yml",
            },
            createdBy: "owner",
            deploys: { image: "ghcr.io/acme/blog:1", sourceType: "image" },
            environment: "MODE=review\nSECRET_KEY=made-once\n",
            name: "Journal",
            relayId,
          })
          // Its owner's own variable, written among the Brick's.
          yield* updateAppConfigEffect(relayId, appId, (config) => ({
            ...config,
            environment:
              "# Mail\nSMTP_HOST=mail.example.test\nMODE=review\nSECRET_KEY=made-once\n",
          }))

          // A variable the revision newly sets that its owner already set
          // is theirs: it is refused, and nothing changes, until they
          // remove it.
          const withOwn = (environment: string) =>
            updateAppConfigEffect(relayId, appId, (config) => ({
              ...config,
              environment,
            }))
          const written = (yield* saved).config.environment
          yield* withOwn(`${written}API_TOKEN=mine\n`)
          assert.include(yield* install(blog), "API_TOKEN")
          assert.strictEqual((yield* saved).config.image, "ghcr.io/acme/blog:1")
          assert.deepStrictEqual(queue.asked, [])
          yield* withOwn(written)

          assert.isNull(yield* install(blog))

          const app = yield* saved
          const token = String(app.brick?.answers.token)
          assert.strictEqual(app.config.image, "ghcr.io/acme/blog:2")
          // The variable it dropped is gone, the secret it had is the same,
          // and the one it newly asks for was made.
          assert.strictEqual(
            app.config.environment,
            `# Mail\nSMTP_HOST=mail.example.test\nSECRET_KEY=made-once\nAPI_TOKEN=${token}\n`
          )
          assert.match(token, /^[\w-]{32}$/u)
          // An input it newly asks is kept at what it came to, and one it
          // dropped is forgotten.
          assert.deepStrictEqual(app.brick, {
            answers: { key: "made-once", region: "eu", token },
            environment: ["SECRET_KEY", "API_TOKEN"],
            name: "Blog",
            revision: 2,
            source: "https://bricks.test/blog.yml",
          })
          // Its configuration deploys as an update, not an image's.
          assert.deepStrictEqual(queue.asked, [
            {
              appId,
              brick: true,
              relayId,
              trigger: "update",
              userId: "owner",
            },
          ])

          // Detached, it is its owner's: nothing of it is made again.
          yield* detachAppBrickEffect(relayId, appId)
          assert.include(yield* install(blog, 3), "follows no Brick")
          assert.strictEqual((yield* saved).config.image, "ghcr.io/acme/blog:2")
          assert.strictEqual(queue.asked.length, 1)
        })
    )

    it.effect(
      "in a group, is connected again to the database the group has, and never to other members",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* createManagedDatabaseRecordEffect({
            brickId: "postgres",
            brickSource: "https://bricks.test/postgres.yml",
            createdBy: "owner",
            databaseId,
            databaseName: "kiln_main",
            engine: "postgres",
            internalPort: 5432,
            name: "Stats",
            password: "first-password",
            relayId,
            username: "kiln_user",
          })
          yield* createAppRecordEffect({
            appId,
            brick: {
              answers: {},
              connect: ["database"],
              environment: ["DATABASE_URL"],
              member: "web",
              name: "Analytics",
              revision: 1,
              source: "https://bricks.test/analytics.yml",
            },
            createdBy: "owner",
            deploys: { image: "ghcr.io/acme/analytics:1", sourceType: "image" },
            environment: "DATABASE_URL=postgresql://stale\n",
            name: "Stats",
            relayId,
          })
          yield* createInstanceGroupEffect({
            brick: {
              answers: {},
              databases: { database: { brick: "postgres", variables: {} } },
              source: "https://bricks.test/analytics.yml",
            },
            createdBy: "owner",
            id: groupId,
            name: "Stats",
          })
          yield* addInstanceGroupMemberEffect(groupId, {
            instanceId: databaseId,
            kind: "database",
            member: "database",
            relayId,
          })
          yield* addInstanceGroupMemberEffect(groupId, {
            instanceId: appId,
            kind: "app",
            member: "web",
            relayId,
          })
          // Its password changed since the App was given it.
          yield* rotateManagedDatabaseCredentialEffect(
            relayId,
            databaseId,
            "second-password"
          )

          // A revision that makes another member isn't an update.
          const grown = analytics({
            cache: { brick: "valkey" },
            database: { brick: "postgres" },
            web,
          })
          assert.include(yield* install(grown), "other members")
          // Nor is one that makes its database another way, as at another
          // version: that would be another database.
          const moved = analytics({
            database: { brick: "postgres", inputs: { version: "16" } },
            web,
          })
          assert.include(yield* install(moved), "another way")
          assert.strictEqual(
            (yield* saved).config.image,
            "ghcr.io/acme/analytics:1"
          )
          assert.deepStrictEqual(queue.asked, [])

          assert.isNull(
            yield* install(analytics({ database: { brick: "postgres" }, web }))
          )
          const app = yield* saved
          assert.strictEqual(app.config.image, "ghcr.io/acme/analytics:2")
          assert.match(
            app.config.environment,
            new RegExp(
              `^SECRET_KEY=[\\w-]{32}\\nMODE=production\\nDATABASE_URL=postgresql://kiln_user:second-password@database-${databaseId}:5432/kiln_main\\n$`,
              "u"
            )
          )
          assert.deepStrictEqual(app.brick?.environment, [
            "SECRET_KEY",
            "MODE",
            "DATABASE_URL",
          ])
          assert.strictEqual(app.brick?.revision, 2)
          assert.strictEqual(queue.asked.length, 1)
        })
    )

    it.effect(
      "in a group, takes the secret the group has, whichever of its Apps is first, and no other database",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* createManagedDatabaseRecordEffect({
            brickId: "postgres",
            brickSource: "https://bricks.test/postgres.yml",
            createdBy: "owner",
            databaseId,
            databaseName: "kiln_main",
            engine: "postgres",
            internalPort: 5432,
            name: "Stats",
            password: "first-password",
            relayId,
            username: "kiln_user",
          })
          yield* createInstanceGroupEffect({
            brick: {
              answers: {},
              databases: { database: { brick: "postgres", variables: {} } },
              source: "https://bricks.test/analytics.yml",
            },
            createdBy: "owner",
            id: groupId,
            name: "Stats",
          })
          yield* addInstanceGroupMemberEffect(groupId, {
            instanceId: databaseId,
            kind: "database",
            member: "database",
            relayId,
          })
          // Two Apps of it: one reaches the database, the other doesn't.
          const members = [
            { connect: ["database"], id: appId, member: "web" },
            { connect: [], id: workerId, member: "worker" },
          ]
          for (const { connect, id, member } of members) {
            yield* createAppRecordEffect({
              appId: id,
              brick: {
                answers: {},
                connect,
                environment: [],
                member,
                name: "Analytics",
                revision: 1,
                source: "https://bricks.test/analytics.yml",
              },
              createdBy: "owner",
              deploys: {
                image: "ghcr.io/acme/analytics:1",
                sourceType: "image",
              },
              environment: "",
              name: `Stats ${member}`,
              relayId,
            })
            yield* addInstanceGroupMemberEffect(groupId, {
              instanceId: id,
              kind: "app",
              member,
              relayId,
            })
          }
          const worker = {
            kind: "app",
            deploy: {
              type: "image",
              image: "ghcr.io/acme/analytics-worker:2",
              env: { SECRET_KEY: "{{ key }}" },
            },
          }

          // A revision that has an App reach a database it wasn't connected
          // to would write it an address it can't reach: it isn't an update.
          const reaching = analytics({
            database: { brick: "postgres" },
            web,
            worker: {
              ...worker,
              connect: { database: { DATABASE_URL: "{{ connection }}" } },
            },
          })
          assert.include(yield* install(reaching, 2, workerId), "connects")
          assert.strictEqual(
            (yield* savedOf(workerId)).config.image,
            "ghcr.io/acme/analytics:1"
          )
          assert.deepStrictEqual(queue.asked, [])

          // Both updated at once: the secret the revision newly asks for is
          // made once, and is the group's, not each App's own.
          const revised = analytics({
            database: { brick: "postgres" },
            web,
            worker,
          })
          assert.deepStrictEqual(
            yield* Effect.all(
              [install(revised), install(revised, 2, workerId)],
              { concurrency: "unbounded" }
            ),
            [null, null]
          )
          const key = (of: string) =>
            Effect.map(
              savedOf(of),
              (app) => /^SECRET_KEY=(.+)$/mu.exec(app.config.environment)?.[1]
            )
          assert.match(String(yield* key(appId)), /^[\w-]{32}$/u)
          assert.strictEqual(yield* key(workerId), yield* key(appId))
        })
    )
  })
})
