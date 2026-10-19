import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  getUserAccessHandler,
  getUserMinecraftProfilesHandler,
  listManagedUsersHandler,
} from "@/server/users.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const instanceId = "a".repeat(40)
const otherInstanceId = "b".repeat(40)
const now = Date.now()

const sessionUser = (
  id: string,
  role: AuthenticatedUser["role"] = "user"
): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id,
  isDevelopmentBypass: false,
  name: id,
  role,
  status: "enabled",
  twoFactorEnabled: false,
})
const admin = sessionUser("admin", "admin")

const credential = (userId: string) =>
  insertRows("account", {
    id: `account-${userId}`,
    accountId: userId,
    providerId: "credential",
    userId,
    createdAt: new Date(now),
    updatedAt: new Date(now),
  })
const invitation = (id: string, userId: string, accessId: string | null) =>
  insertRows("invitation", {
    id,
    token_hash: id.padEnd(64, "0"),
    email: `${userId}@example.test`,
    user_id: userId,
    access_id: accessId,
    access_type: accessId ? "scoped" : "relay_creator",
    relay_id: accessId ? relayId : null,
    invited_by: "admin",
    expires_at: now + 60_000,
    created_at: now - 60_000,
  })

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("admin", { role: "admin" })
  yield* credential("admin")
  // Signed in, owns one game server, holds another and the Relay.
  yield* insertUser("member")
  yield* credential("member")
  // Invited, hasn't signed in or accepted.
  yield* insertUser("invited")
  // Invited to the platform only.
  yield* insertUser("platform-invited")
  // Was invited, then removed: nothing left.
  yield* insertUser("removed")
  yield* insertUser("disabled", { status: "disabled" })
  yield* credential("disabled")

  yield* insertRelay(relayId)
  yield* insertInstance(relayId, instanceId, { owner_id: "member" })
  yield* insertInstance(relayId, otherInstanceId)
  yield* insertGrant({
    id: "11111111-1111-4111-8111-111111111111",
    userId: "member",
    relayId,
    resourceType: "instance",
    resourceId: otherInstanceId,
  })
  yield* insertRows("access_selection", {
    access_id: "11111111-1111-4111-8111-111111111111",
    selection_kind: "permission",
    selection_key: "instance.read",
  })
  yield* insertGrant({
    id: "22222222-2222-4222-8222-222222222222",
    userId: "member",
    relayId,
    resourceType: "relay",
    resourceId: relayId,
  })
  yield* insertRows("access_preset", {
    id: "66666666-6666-4666-8666-666666666666",
    access_id: "22222222-2222-4222-8222-222222222222",
    preset_id: null,
    builtin_key: "kiln.observer",
    created_at: now,
  })
  yield* insertGrant({
    id: "33333333-3333-4333-8333-333333333333",
    userId: "invited",
    relayId,
    resourceType: "instance",
    resourceId: otherInstanceId,
    state: "pending",
  })
  yield* invitation(
    "44444444-4444-4444-8444-444444444444",
    "invited",
    "33333333-3333-4333-8333-333333333333"
  )
  yield* invitation(
    "55555555-5555-4555-8555-555555555555",
    "platform-invited",
    null
  )
  yield* insertGrant({
    userId: "removed",
    relayId,
    resourceType: "instance",
    resourceId: otherInstanceId,
    state: "revoked",
  })
})

const list = (actor: AuthenticatedUser, search?: string) =>
  Effect.promise(() =>
    listManagedUsersHandler(actor, { search, offset: 0, limit: 50 })
  )

describeMysql("platform users", () => {
  layer(TestDatabase)((it) => {
    it.effect("only platform administrators can list users", () =>
      Effect.gen(function* () {
        yield* seed
        const result = yield* Effect.exit(
          Effect.tryPromise(() =>
            listManagedUsersHandler(sessionUser("member"), {
              offset: 0,
              limit: 50,
            })
          )
        )
        assert.isTrue(result._tag === "Failure")
      })
    )

    it.effect(
      "lists invited people as pending and leaves out those removed",
      () =>
        Effect.gen(function* () {
          yield* seed
          const { items } = yield* list(admin)
          const states = Object.fromEntries(
            items.map((user) => [user.id, user.state])
          )
          assert.deepStrictEqual(states, {
            admin: "active",
            member: "active",
            invited: "pending",
            "platform-invited": "pending",
            disabled: "disabled",
          })
          assert.strictEqual(
            items.find((user) => user.id === "platform-invited")?.invitedRole,
            "relay_creator"
          )
        })
    )

    it.effect("counts what each person holds, owned and invited", () =>
      Effect.gen(function* () {
        yield* seed
        const { items } = yield* list(admin)
        const access = (id: string) =>
          items.find((user) => user.id === id)?.access
        assert.deepStrictEqual(access("member"), {
          relays: 1,
          instances: 2,
          apps: 0,
          databases: 0,
          owned: 1,
          pending: 0,
        })
        assert.deepStrictEqual(access("invited"), {
          relays: 0,
          instances: 0,
          apps: 0,
          databases: 0,
          owned: 0,
          pending: 1,
        })
        // Administrators reach every resource on enabled Relays.
        assert.deepStrictEqual(access("admin"), {
          relays: 1,
          instances: 2,
          apps: 0,
          databases: 0,
          owned: 0,
          pending: 0,
        })
      })
    )

    it.effect("only platform administrators can read a user's access", () =>
      Effect.gen(function* () {
        yield* seed
        const result = yield* Effect.exit(
          Effect.tryPromise(() =>
            getUserAccessHandler(sessionUser("member"), "invited")
          )
        )
        assert.isTrue(result._tag === "Failure")
      })
    )

    it.effect("reads a user's grants, presets, and what they own", () =>
      Effect.gen(function* () {
        yield* seed
        const access = yield* Effect.promise(() =>
          getUserAccessHandler(admin, "member")
        )
        assert.deepStrictEqual(
          access.grants.map((grant) => ({
            scope: grant.scope.resourceType,
            selections: grant.selections.map((selection) => selection.key),
            builtinKeys: grant.builtinKeys,
          })),
          [
            { scope: "relay", selections: [], builtinKeys: ["kiln.observer"] },
            {
              scope: "instance",
              selections: ["instance.read"],
              builtinKeys: [],
            },
          ]
        )
        assert.deepStrictEqual(
          access.owned.map((resource) => resource.scope.resourceId),
          [instanceId]
        )

        const invited = yield* Effect.promise(() =>
          getUserAccessHandler(admin, "invited")
        )
        assert.strictEqual(
          invited.grants[0]?.invitationId,
          "44444444-4444-4444-8444-444444444444"
        )
        const platform = yield* Effect.promise(() =>
          getUserAccessHandler(admin, "platform-invited")
        )
        assert.deepStrictEqual(platform.platformInvitationIds, [
          "55555555-5555-4555-8555-555555555555",
        ])
      })
    )

    it.effect(
      "outside the platform view, heads need a resource whose people you can read",
      () =>
        Effect.gen(function* () {
          yield* seed
          const scope = {
            relayId,
            resourceType: "instance",
            resourceId: otherInstanceId,
          } as const
          // No resource at all.
          const unscoped = yield* Effect.exit(
            Effect.tryPromise(() =>
              getUserMinecraftProfilesHandler(sessionUser("member"), [
                "invited",
              ])
            )
          )
          assert.isTrue(unscoped._tag === "Failure")
          // member can read the game server, but not who has access to it.
          const unreadable = yield* Effect.exit(
            Effect.tryPromise(() =>
              getUserMinecraftProfilesHandler(
                sessionUser("member"),
                ["invited"],
                scope
              )
            )
          )
          assert.isTrue(unreadable._tag === "Failure")
        })
    )

    it.effect(
      "removal sees access on disabled Relays, and only real ownership blocks it",
      () =>
        Effect.gen(function* () {
          yield* seed
          const disabledRelayId = "d".repeat(43)
          const databaseId = "c".repeat(40)
          yield* insertRelay(disabledRelayId, { enabled: false })
          yield* insertInstance(disabledRelayId, "e".repeat(40), {
            owner_id: "disabled",
          })
          yield* insertGrant({
            id: "88888888-8888-4888-8888-888888888888",
            userId: "member",
            relayId: disabledRelayId,
            resourceType: "relay",
            resourceId: disabledRelayId,
          })
          // Creating a database confers no ownership.
          yield* insertRows("database", {
            database_id: databaseId,
            relay_id: relayId,
            name: "made-by-grumm",
            engine: "mysql",
            database_name: "made",
            username: "made",
            password_ciphertext: "ciphertext",
            created_by: "member",
            created_at: now,
            updated_at: now,
          })

          const access = yield* Effect.promise(() =>
            getUserAccessHandler(admin, "member")
          )
          const disabled = access.grants.find(
            (grant) => grant.scope.relayId === disabledRelayId
          )
          assert.strictEqual(disabled?.relayEnabled, false)
          assert.isFalse(
            access.owned.some(
              (resource) => resource.scope.resourceId === databaseId
            )
          )

          const { items } = yield* list(admin)
          const counts = (id: string) =>
            items.find((user) => user.id === id)?.access
          // member's database counts don't change, and their game server is
          // their only ownership.
          assert.strictEqual(counts("member")?.databases, 0)
          assert.strictEqual(counts("member")?.owned, 1)
          // A game server owned on a disabled Relay still blocks removal.
          assert.strictEqual(counts("disabled")?.owned, 1)
          assert.strictEqual(counts("disabled")?.instances, 0)
        })
    )

    it.effect("an expired invitation isn't counted as one to accept", () =>
      Effect.gen(function* () {
        yield* seed
        yield* insertUser("expired")
        yield* insertGrant({
          id: "99999999-9999-4999-8999-999999999999",
          userId: "expired",
          relayId,
          resourceType: "instance",
          resourceId: otherInstanceId,
          state: "pending",
        })
        yield* insertRows("invitation", {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          token_hash: "a".repeat(64),
          email: "expired@example.test",
          user_id: "expired",
          access_id: "99999999-9999-4999-8999-999999999999",
          access_type: "scoped",
          relay_id: relayId,
          invited_by: "admin",
          expires_at: now - 60_000,
          created_at: now - 120_000,
        })
        const { items } = yield* list(admin)
        assert.strictEqual(
          items.find((user) => user.id === "expired")?.access.pending,
          0
        )
      })
    )
  })
})
