import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import type { AuthenticatedUser } from "@/lib/auth-session"
import { transferInstanceOwnershipEffect } from "@/lib/platform-access"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertUser,
  selectRows,
} from "@/test/seed"

const now = Date.UTC(2026, 8, 9)
const relayId = "r".repeat(43)
const instanceId = "a".repeat(40)
const input = { relayId, instanceId, userId: "recipient" }

// The session still says Platform Admin and enabled; the database is current.
const actor: AuthenticatedUser = {
  id: "actor",
  email: "actor@example.test",
  emailVerified: false,
  emailVerifiedAt: null,
  manuallyVerifiedAt: "2026-09-08T00:00:00Z",
  legacyVerificationRecordedAt: null,
  status: "enabled",
  name: "Actor",
  role: "admin",
  isDevelopmentBypass: false,
  twoFactorEnabled: false,
}

const seed = (options: {
  actor?: Record<string, string | Date | null>
  ownerId: string
  recipientGrant?: "active" | "pending"
}) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* TestClock.setTime(now)
    const verified = { manuallyVerifiedAt: new Date("2026-09-08T00:00:00Z") }
    yield* insertUser("actor", { role: "user", ...verified, ...options.actor })
    yield* insertUser("owner", verified)
    yield* insertUser("recipient", verified)
    yield* insertRelay(relayId, { created_by: "someone" })
    yield* insertInstance(relayId, instanceId, { owner_id: options.ownerId })
    yield* insertGrant({
      userId: "recipient",
      relayId,
      resourceType: "instance",
      resourceId: instanceId,
      role: "viewer",
      state: options.recipientGrant ?? "active",
    })
  })

const instanceOwner = Effect.map(
  selectRows<{ owner_id: string | null }>("instance"),
  ([instance]) => instance?.owner_id
)

describeMysql("ownership transfer fresh authority", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "rejects a disabled actor despite an earlier eligible session",
      () =>
        Effect.gen(function* () {
          yield* seed({ actor: { status: "disabled" }, ownerId: "actor" })

          const error = yield* transferInstanceOwnershipEffect(
            actor,
            input
          ).pipe(Effect.flip)

          assert.include(error.message, "cannot manage resource access")
          assert.strictEqual(yield* instanceOwner, "actor")
        })
    )

    it.effect(
      "discards an old elapsed disable expiry when the account is now indefinitely disabled",
      () =>
        Effect.gen(function* () {
          yield* seed({
            actor: { status: "disabled", statusExpiresAt: null },
            ownerId: "actor",
          })

          const error = yield* transferInstanceOwnershipEffect(
            { ...actor, statusExpiresAt: "2000-01-01T00:00:00Z" },
            input
          ).pipe(Effect.flip)

          assert.include(error.message, "cannot manage resource access")
          assert.strictEqual(yield* instanceOwner, "actor")
        })
    )

    it.effect(
      "rejects a demoted administrator who does not currently own the instance",
      () =>
        Effect.gen(function* () {
          yield* seed({ ownerId: "owner" })

          const error = yield* transferInstanceOwnershipEffect(
            actor,
            input
          ).pipe(Effect.flip)

          assert.include(error.message, "Only the server owner")
          assert.strictEqual(yield* instanceOwner, "owner")
        })
    )

    it.effect("requires the new owner to hold active server access", () =>
      Effect.gen(function* () {
        yield* seed({ ownerId: "actor", recipientGrant: "pending" })

        const error = yield* transferInstanceOwnershipEffect(actor, input).pipe(
          Effect.flip
        )

        assert.include(error.message, "active server access")
        assert.strictEqual(yield* instanceOwner, "actor")
      })
    )

    it.effect(
      "transfers from the current owner and revises both users' authority",
      () =>
        Effect.gen(function* () {
          yield* seed({ ownerId: "actor" })

          const result = yield* transferInstanceOwnershipEffect(actor, input)

          assert.deepEqual(result, {
            transferred: true,
            previousOwnerId: "actor",
          })
          assert.strictEqual(yield* instanceOwner, "recipient")
          const grants = yield* selectRows<{ user_id: string; state: string }>(
            "access_grant"
          )
          assert.deepEqual(
            grants.map(({ user_id, state }) => [user_id, state]),
            [["recipient", "active"]]
          )
          const deliveries = yield* selectRows<{
            subject_id: string
            scope_id: string
          }>("authorization_delivery")
          assert.sameDeepMembers(
            deliveries.map(({ subject_id, scope_id }) => [
              subject_id,
              scope_id,
            ]),
            [
              ["actor", instanceId],
              ["recipient", instanceId],
            ]
          )
        })
    )
  })
})
