import { assert, layer } from "@effect/vitest"
import { Clock, Effect } from "effect"
import { vi } from "vite-plus/test"

import {
  loadInstanceUpdateEffect,
  recordInstanceImageCheckEffect,
  saveInstanceUpdatePolicyEffect,
} from "@/effect/instance-updates"
import {
  createAppRecordEffect,
  detachAppBrickEffect,
  updateAppConfigEffect,
} from "@/effect/managed-apps"
import { createManagedDatabaseRecordEffect } from "@/effect/managed-databases"
import { notifyUsersEffect, openSourceKeysEffect } from "@/effect/notifications"
import { recordCheckedImageEffect } from "@/lib/instance-updates.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay, insertUser } from "@/test/seed"

// Catalogs are fetched over the network; none has these Bricks.
vi.mock("@/lib/brick-revisions.server", () => ({
  newestBrickRevision: async () => null,
}))

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const relayId = "1".repeat(12)
const appId = "a".repeat(12)
const image = "ghcr.io/kiln-site/marketing:latest"
const digest = (n: number) => `sha256:${String(n).repeat(64)}`

describeMysql("App image checks", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "keep what a newer check found over an older one answering late",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("user")
          yield* createAppRecordEffect({
            appId,
            createdBy: "user",
            name: "Website",
            relayId,
          })
          yield* saveInstanceUpdatePolicyEffect("app", appId, {
            delayHours: 0,
            mode: "notify",
          })
          const askedAt = 1_800_000_000_000
          const newer = yield* recordInstanceImageCheckEffect(
            "app",
            appId,
            image,
            {
              id: appId,
              image,
              latestDigest: digest(3),
              runningDigests: [digest(1)],
              status: "checked",
            },
            askedAt
          )
          assert.isTrue(newer.newlySeen)

          // Asked earlier, it answers after: it says nothing new.
          const older = yield* recordInstanceImageCheckEffect(
            "app",
            appId,
            image,
            { id: appId, error: "registry timed out", status: "error" },
            askedAt - 60_000
          )
          assert.isFalse(older.newFailure)
          assert.isFalse(older.newlySeen)

          const kept = yield* loadInstanceUpdateEffect(appId)
          assert.strictEqual(kept?.latestDigest, digest(3))
          assert.strictEqual(kept?.checkedAt, askedAt)
        })
    )

    // A database runs what its container was made from, which only its
    // Relay knows: the check says which image, and who may deploy it hears.
    it.effect(
      "tell whoever can deploy a database that its image moved, until it's taken",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          const databaseId = "d".repeat(12)
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
          const found = (running: number) =>
            Clock.currentTimeMillis.pipe(
              Effect.flatMap((askedAt) =>
                recordCheckedImageEffect(
                  "database",
                  { id: relayId } as PersistedRelay,
                  databaseId,
                  {
                    answers: [
                      {
                        askedAt,
                        result: {
                          id: databaseId,
                          image: "postgres:17",
                          latestDigest: digest(2),
                          runningDigests: [digest(running)],
                          status: "checked",
                        },
                        subject: { id: databaseId, image: null, name: "Main" },
                      },
                    ],
                    unchecked: false,
                  },
                  null
                )
              )
            )
          const open = openSourceKeysEffect(
            "instance.image-update",
            `instance.image-update:${databaseId}:`
          )

          const offered = yield* found(1)
          assert.deepInclude(offered, {
            image: "postgres:17",
            kind: "database",
            latestDigest: digest(2),
            state: "available",
          })
          assert.deepStrictEqual(yield* open, [
            `instance.image-update:${databaseId}:${digest(2)}`,
          ])

          // Deployed again, it runs what the tag names.
          const taken = yield* found(2)
          assert.strictEqual(taken?.state, "current")
          assert.deepStrictEqual(yield* open, [])
        })
    )

    // Checks overlap, and one may answer after something changed the
    // instance's Brick: what it saw then mustn't be put back.
    it.effect(
      "keep the Brick a newer check found over an older one answering late",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("owner")
          const databaseId = "d".repeat(12)
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
          const answered = (
            askedAt: number,
            brick: { revision: number; source: string }
          ) =>
            recordCheckedImageEffect(
              "database",
              { id: relayId } as PersistedRelay,
              databaseId,
              {
                answers: [
                  {
                    askedAt,
                    result: { brick, id: databaseId, status: "not_deployed" },
                    subject: { id: databaseId, image: null, name: "Main" },
                  },
                ],
                unchecked: false,
              },
              null
            )
          const now = yield* Clock.currentTimeMillis

          yield* answered(now, {
            revision: 2,
            source: "https://bricks.test/postgres.yml",
          })
          const late = yield* answered(now - 60_000, {
            revision: 1,
            source: "https://bricks.test/before.yml",
          })

          assert.deepInclude(late?.brick, {
            revision: 2,
            source: "https://bricks.test/postgres.yml",
          })
        })
    )

    it.effect(
      "keep an update announced after an older check found checks off",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("user")
          yield* createAppRecordEffect({
            appId,
            createdBy: "user",
            name: "Website",
            relayId,
          })
          yield* updateAppConfigEffect(relayId, appId, (config) => ({
            ...config,
            image,
            sourceType: "image",
          }))
          // Checks are on, and a newer check found and announced an update.
          yield* saveInstanceUpdatePolicyEffect("app", appId, {
            delayHours: 0,
            mode: "notify",
          })
          yield* recordInstanceImageCheckEffect(
            "app",
            appId,
            image,
            {
              id: appId,
              image,
              latestDigest: digest(2),
              runningDigests: [digest(1)],
              status: "checked",
            },
            yield* Clock.currentTimeMillis
          )
          const sourceKey = `instance.image-update:${appId}:${digest(2)}`
          yield* notifyUsersEffect(["user"], sourceKey, {
            digest: digest(2),
            image,
            kind: "instance.image-update",
            resource: { id: appId, name: "Website", relayId, type: "app" },
          })

          // An older check, which found checks off, records after it.
          yield* recordCheckedImageEffect(
            "app",
            { id: relayId } as PersistedRelay,
            appId,
            { answers: [], unchecked: true },
            null
          )

          assert.deepStrictEqual(
            yield* openSourceKeysEffect(
              "instance.image-update",
              `instance.image-update:${appId}:`
            ),
            [sourceKey]
          )
        })
    )
    // Its container says which Brick deployed it until it next deploys,
    // whatever became of the App since.
    it.effect(
      "offer a Brick's revision only to an App that still follows the Brick",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertUser("user")
          const source = "https://bricks.test/blog.yml"
          yield* createAppRecordEffect({
            appId,
            brick: {
              answers: {},
              environment: [],
              name: "Blog",
              revision: 1,
              source,
              volumes: [],
            },
            createdBy: "user",
            deploys: { image, sourceType: "image" },
            name: "Journal",
            relayId,
          })
          const seen = (askedAt: number) =>
            recordCheckedImageEffect(
              "app",
              { id: relayId } as PersistedRelay,
              appId,
              {
                answers: [
                  {
                    askedAt,
                    result: {
                      brick: { revision: 1, source },
                      id: appId,
                      status: "changed",
                    },
                    subject: { id: appId, image, name: "Journal" },
                  },
                ],
                unchecked: false,
              },
              null
            )
          const now = yield* Clock.currentTimeMillis

          assert.strictEqual((yield* seen(now))?.brick?.revision, 1)

          yield* detachAppBrickEffect(relayId, appId)
          const after = yield* seen(now + 60_000)
          // Nothing newer was recorded of it: what it has is from before.
          assert.strictEqual(after?.brick?.checkedAt, now)
        })
    )
  })
})
