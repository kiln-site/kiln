import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import { grantsAllowPermission } from "@/lib/access-control"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { transferResourceOwnershipEffect } from "@/lib/platform-access"
import { loadResourceGrantsEffect } from "@/lib/resource-permissions"
import { resourceOwners } from "@/migrations/0022_resource_owners"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

const now = Date.UTC(2026, 9, 22)
const relayId = "r".repeat(43)
const otherRelayId = "s".repeat(43)
const verified = { manuallyVerifiedAt: new Date("2026-09-08T00:00:00Z") }

const insertDatabase = (
  id: string,
  row: Record<string, string | null>,
  relay = relayId
) =>
  insertRows("database", {
    database_id: id,
    relay_id: relay,
    name: id,
    engine: "mysql",
    database_name: `db_${id.slice(0, 8)}`,
    username: `u_${id.slice(0, 8)}`,
    password_ciphertext: "ciphertext",
    created_at: new Date(now),
    updated_at: new Date(now),
    created_by: "creator",
    ...row,
  })

const insertApp = (
  id: string,
  row: Record<string, string | null>,
  relay = relayId
) =>
  insertRows("app", {
    app_id: id,
    relay_id: relay,
    name: id,
    config_ciphertext: "ciphertext",
    created_at: now,
    updated_at: now,
    created_by: "creator",
    ...row,
  })

const owners = (table: "app" | "database" | "instance", id: string) =>
  Effect.map(
    selectRows<Record<string, string | null>>(table),
    (rows) =>
      new Map(
        rows.map((row) => [row[id], row.owner_id] as [string, string | null])
      )
  )

const user = (id: string, role: AuthenticatedUser["role"] = "user") =>
  ({
    id,
    email: `${id}@example.test`,
    emailVerified: false,
    emailVerifiedAt: null,
    manuallyVerifiedAt: "2026-09-08T00:00:00Z",
    legacyVerificationRecordedAt: null,
    status: "enabled",
    name: id,
    role,
    isDevelopmentBypass: false,
    twoFactorEnabled: false,
  }) satisfies AuthenticatedUser

describeMysql("resource ownership", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "gives existing resources an owner without anyone gaining access",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("admin", { role: "admin", ...verified })
          yield* insertUser("relay-owner", verified)
          yield* insertUser("creator", verified)
          yield* insertRelay(relayId, { created_by: "relay-owner" })
          // A bootstrap Relay nobody paired.
          yield* insertRelay(otherRelayId, { created_by: null })
          // The creator still has some Relay access; it doesn't make them
          // an owner.
          yield* insertGrant({
            userId: "creator",
            relayId,
            resourceType: "relay",
            resourceId: relayId,
          })
          const ids = (prefix: string) => prefix.repeat(40)
          yield* insertDatabase(ids("a"), {
            created_by: "admin",
            owner_id: null,
          })
          yield* insertDatabase(ids("b"), {
            created_by: "relay-owner",
            owner_id: null,
          })
          yield* insertDatabase(ids("c"), {
            created_by: "creator",
            owner_id: null,
          })
          yield* insertDatabase(ids("d"), {
            created_by: "creator",
            owner_id: "admin",
          })
          yield* insertDatabase(
            ids("e"),
            { created_by: "creator", owner_id: null },
            otherRelayId
          )
          yield* insertApp(ids("f"), { created_by: "creator", owner_id: null })
          yield* insertApp(ids("0"), { created_by: "admin", owner_id: null })
          yield* insertInstance(relayId, ids("1"), { owner_id: null })
          yield* insertInstance(relayId, ids("2"), { owner_id: "creator" })
          yield* insertInstance(otherRelayId, ids("3"), { owner_id: null })

          yield* resourceOwners.run

          const databases = yield* owners("database", "database_id")
          assert.strictEqual(databases.get(ids("a")), "admin")
          assert.strictEqual(databases.get(ids("b")), "relay-owner")
          assert.strictEqual(databases.get(ids("c")), "relay-owner")
          assert.strictEqual(databases.get(ids("d")), "admin")
          assert.strictEqual(databases.get(ids("e")), null)
          const apps = yield* owners("app", "app_id")
          assert.strictEqual(apps.get(ids("f")), "relay-owner")
          assert.strictEqual(apps.get(ids("0")), "admin")
          const instances = yield* owners("instance", "instance_id")
          assert.strictEqual(instances.get(ids("1")), "relay-owner")
          // Until its Relay's audit log names who made it.
          const provisional = new Map(
            (yield* selectRows<{
              instance_id: string
              owner_provisional: number
            }>("instance")).map((row) => [
              row.instance_id,
              Boolean(row.owner_provisional),
            ])
          )
          assert.isTrue(provisional.get(ids("1")))
          assert.isFalse(provisional.get(ids("2")))
          assert.strictEqual(instances.get(ids("2")), "creator")
          assert.strictEqual(instances.get(ids("3")), null)
        })
    )

    it.effect(
      "gives owners authority over what they own and nothing else",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertUser("owner", verified)
          yield* insertRelay(relayId, { created_by: "someone" })
          const ownDatabase = "a".repeat(40)
          const otherDatabase = "b".repeat(40)
          const ownApp = "c".repeat(40)
          const otherApp = "d".repeat(40)
          yield* insertDatabase(ownDatabase, { owner_id: "owner" })
          yield* insertDatabase(otherDatabase, { owner_id: "someone" })
          yield* insertApp(ownApp, { owner_id: "owner" })
          yield* insertApp(otherApp, { owner_id: "someone" })

          const grants = yield* loadResourceGrantsEffect("owner")

          assert.isTrue(
            grantsAllowPermission(grants, "database.delete", {
              relayId,
              databaseId: ownDatabase,
            })
          )
          assert.isTrue(
            grantsAllowPermission(grants, "database.credentials.read", {
              relayId,
              databaseId: ownDatabase,
            })
          )
          assert.isFalse(
            grantsAllowPermission(grants, "database.read", {
              relayId,
              databaseId: otherDatabase,
            })
          )
          for (const permission of ["app.read", "app.delete"] as const)
            assert.isTrue(
              grantsAllowPermission(grants, permission, {
                relayId,
                appId: ownApp,
              })
            )
          // What an app runs can reach the node, so changing it, its shell,
          // and its files still take app permissions on the Relay.
          for (const permission of [
            "app.manage",
            "app.terminal",
            "app.files.write",
          ] as const)
            assert.isFalse(
              grantsAllowPermission(grants, permission, {
                relayId,
                appId: ownApp,
              })
            )
          assert.isFalse(
            grantsAllowPermission(grants, "app.read", {
              relayId,
              appId: otherApp,
            })
          )
          // Owning an app isn't access to every app on its Relay, nor to
          // the Relay.
          assert.isFalse(
            grantsAllowPermission(grants, "app.read", { relayId })
          )
          assert.isFalse(
            grantsAllowPermission(grants, "relay.read", { relayId })
          )
          // Nor to people, presets, backups or schedules on it.
          assert.isFalse(
            grants.some(
              (grant) =>
                grant.resourceType === "app" &&
                grant.permissions.some(
                  (permission) =>
                    permission.startsWith("access.") ||
                    permission.startsWith("backup.") ||
                    permission.startsWith("schedule.")
                )
            )
          )
        })
    )

    it.effect(
      "transfers a database to someone with access to it and revokes the old owner's",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* TestClock.setTime(now)
          yield* insertUser("owner", verified)
          yield* insertUser("outsider", verified)
          yield* insertUser("recipient", verified)
          yield* insertRelay(relayId, { created_by: "someone" })
          const databaseId = "a".repeat(40)
          yield* insertDatabase(databaseId, { owner_id: "owner" })
          yield* insertGrant({
            userId: "recipient",
            relayId,
            resourceType: "database",
            resourceId: databaseId,
          })
          const transfer = (actor: string, to: string) =>
            transferResourceOwnershipEffect(user(actor), {
              relayId,
              resourceType: "database",
              resourceId: databaseId,
              userId: to,
            })

          const notOwner = yield* transfer("recipient", "recipient").pipe(
            Effect.flip
          )
          assert.include(notOwner.message, "Only the database owner")
          const noAccess = yield* transfer("owner", "outsider").pipe(
            Effect.flip
          )
          assert.include(noAccess.message, "access to the database")

          yield* transfer("owner", "recipient")

          assert.strictEqual(
            (yield* owners("database", "database_id")).get(databaseId),
            "recipient"
          )
          const ownerGrants = yield* loadResourceGrantsEffect("owner")
          assert.isFalse(
            grantsAllowPermission(ownerGrants, "database.read", {
              relayId,
              databaseId,
            })
          )
        })
    )

    it.effect("transfers an app only to someone with Relay access", () =>
      Effect.gen(function* () {
        yield* resetDatabase
        yield* TestClock.setTime(now)
        yield* insertUser("owner", verified)
        yield* insertUser("recipient", verified)
        yield* insertRelay(relayId, { created_by: "someone" })
        const appId = "a".repeat(40)
        yield* insertApp(appId, { owner_id: "owner" })
        const transfer = transferResourceOwnershipEffect(user("owner"), {
          relayId,
          resourceType: "app",
          resourceId: appId,
          userId: "recipient",
        })

        const error = yield* transfer.pipe(Effect.flip)
        assert.include(error.message, "access to the Relay")
        assert.strictEqual((yield* owners("app", "app_id")).get(appId), "owner")

        yield* insertGrant({
          userId: "recipient",
          relayId,
          resourceType: "relay",
          resourceId: relayId,
        })
        yield* transfer

        assert.strictEqual(
          (yield* owners("app", "app_id")).get(appId),
          "recipient"
        )
      })
    )
  })
})
