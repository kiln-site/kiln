import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import {
  assignPlatformAccessEffect,
  removePlatformAccessEffect,
} from "@/lib/platform-access"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

const now = Date.UTC(2026, 7, 23, 12)
const relayId = "r".repeat(43)

const insertMember = (id: string, role: string, status = "enabled") =>
  insertUser(id, { role, status, emailVerifiedAt: new Date(now - 60_000) })

// Scoped access a platform role change must leave alone.
const insertScopedAccess = (userId: string) =>
  Effect.gen(function* () {
    yield* insertGrant({
      userId,
      relayId,
      resourceType: "relay",
      resourceId: relayId,
      role: "operator",
    })
    yield* insertRows("session", {
      id: `session-${userId}`,
      token: `token-${userId}`,
      userId,
      expiresAt: new Date(now + 60_000),
      createdAt: new Date(now - 60_000),
      updatedAt: new Date(now - 60_000),
    })
    yield* insertRows("cli_credential", {
      id: `00000000-0000-4000-8000-${userId.padStart(12, "0").slice(-12)}`,
      user_id: userId,
      name: "CLI",
      token_hash: userId.padEnd(64, "0").slice(0, 64),
      access_mode: "full_access",
      created_at: now - 60_000,
    })
  })

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* TestClock.setTime(now)
  yield* insertRelay(relayId)
})

const roles = Effect.map(
  selectRows<{ id: string; role: string | null }>("user"),
  (users) => Object.fromEntries(users.map((user) => [user.id, user.role]))
)

const expectScopedAccessKept = (userId: string) =>
  Effect.gen(function* () {
    const grants = yield* selectRows<{ user_id: string }>("access_grant")
    const sessions = yield* selectRows<{ userId: string }>("session")
    const credentials = yield* selectRows<{
      user_id: string
      revoked_at: number | null
    }>("cli_credential")
    assert.deepEqual(
      grants.map((grant) => grant.user_id),
      [userId]
    )
    assert.deepEqual(
      sessions.map((session) => session.userId),
      [userId]
    )
    assert.deepEqual(
      credentials.map((credential) => [
        credential.user_id,
        credential.revoked_at,
      ]),
      [[userId, null]]
    )
  })

const authorizationRevision = (userId: string) =>
  Effect.map(
    selectRows<{ user_id: string; revision: number }>("authorization_subject"),
    (rows) => Number(rows.find((row) => row.user_id === userId)?.revision ?? 0)
  )

describeMysql("platform access changes", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "preserves scoped grants and credentials while revising authority on promotion",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertMember("admin", "admin")
          yield* insertMember("operator", "user")
          yield* insertScopedAccess("operator")

          yield* assignPlatformAccessEffect({
            accessType: "platform_admin",
            actingUserId: "admin",
            developmentBypass: false,
            userId: "operator",
          })

          assert.strictEqual((yield* roles).operator, "admin")
          yield* expectScopedAccessKept("operator")
          assert.strictEqual(yield* authorizationRevision("operator"), 1)
          const deliveries = yield* selectRows<{
            relay_id: string
            subject_id: string
          }>("authorization_delivery")
          assert.deepEqual(
            deliveries.map((row) => [row.relay_id, row.subject_id]),
            [[relayId, "operator"]]
          )
        })
    )

    it.effect("protects the last platform administrator", () =>
      Effect.gen(function* () {
        yield* seed
        yield* insertMember("admin-one", "admin")

        const error = yield* removePlatformAccessEffect({
          actingUserId: "admin-one",
          developmentBypass: false,
          targetUserId: "admin-one",
        }).pipe(Effect.flip)

        assert.include(error.message, "Platform Admin is required")
        assert.deepEqual(yield* roles, { "admin-one": "admin" })
        assert.strictEqual(yield* authorizationRevision("admin-one"), 0)
      })
    )

    it.effect(
      "does not count disabled administrators as a usable replacement",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertMember("admin-one", "admin")
          yield* insertMember("admin-two", "admin", "disabled")

          const error = yield* removePlatformAccessEffect({
            actingUserId: "admin-one",
            developmentBypass: false,
            targetUserId: "admin-one",
          }).pipe(Effect.flip)

          assert.include(error.message, "Platform Admin is required")
          assert.deepEqual(yield* roles, {
            "admin-one": "admin",
            "admin-two": "admin",
          })
        })
    )

    it.effect(
      "rechecks the assigning administrator inside the transaction",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertMember("admin", "admin")
          yield* insertMember("former-admin", "user")
          yield* insertMember("operator", "user")

          const error = yield* assignPlatformAccessEffect({
            accessType: "platform_admin",
            actingUserId: "former-admin",
            developmentBypass: false,
            userId: "operator",
          }).pipe(Effect.flip)

          assert.include(error.message, "Only a platform administrator")
          assert.strictEqual((yield* roles).operator, "user")
          assert.strictEqual(yield* authorizationRevision("operator"), 0)
        })
    )

    it.effect(
      "demotes a platform member, cancelling only platform invitations and keeping scoped access",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertMember("admin", "admin")
          yield* insertMember("creator", "relay_creator")
          yield* insertScopedAccess("creator")
          const invitation = (id: string, accessType: string) => ({
            id,
            token_hash: id.padEnd(64, "0"),
            email: "creator@example.test",
            user_id: "creator",
            access_type: accessType,
            relay_id: accessType === "scoped" ? relayId : null,
            invited_by: "admin",
            expires_at: now + 60_000,
            created_at: now - 60_000,
          })
          yield* insertRows("invitation", [
            invitation("platform-invite", "relay_creator"),
            invitation("scoped-invite", "scoped"),
          ])

          yield* removePlatformAccessEffect({
            actingUserId: "admin",
            developmentBypass: false,
            targetUserId: "creator",
          })

          assert.strictEqual((yield* roles).creator, "user")
          yield* expectScopedAccessKept("creator")
          const invitations = yield* selectRows<{
            id: string
            revoked_at: number | null
            cancelled_by: string | null
          }>("invitation")
          assert.sameDeepMembers(
            invitations.map(({ id, revoked_at, cancelled_by }) => ({
              id,
              revoked: revoked_at !== null,
              cancelled_by,
            })),
            [
              { id: "platform-invite", revoked: true, cancelled_by: "admin" },
              { id: "scoped-invite", revoked: false, cancelled_by: null },
            ]
          )
          assert.strictEqual(yield* authorizationRevision("creator"), 1)
        })
    )
  })
})
