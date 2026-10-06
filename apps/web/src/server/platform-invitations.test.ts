import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { TestClock } from "effect/testing"

import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  acceptPlatformInvitationEffect,
  cancelPlatformInvitationEffect,
} from "@/lib/platform-access"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser, selectRows } from "@/test/seed"

const now = Date.UTC(2026, 7, 23, 12)
const tokenHash = "a".repeat(64)

// The session still carries the address the account had when it signed in.
const actor = {
  id: "invitee",
  email: "changed@example.com",
  role: "user",
  isDevelopmentBypass: false,
} as AuthenticatedUser

const seed = (
  options: {
    actorRole?: string
    actorStatus?: string
    invitation?: Record<string, string | number | null>
  } = {}
) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* TestClock.setTime(now)
    yield* insertUser(actor.id, {
      email: actor.email,
      role: options.actorRole ?? "user",
      status: options.actorStatus ?? "enabled",
      emailVerifiedAt: new Date(now - 60_000),
    })
    yield* insertUser("another-account", {
      emailVerifiedAt: new Date(now - 60_000),
    })
    yield* insertRows("invitation", {
      id: "invite",
      token_hash: tokenHash,
      email: "old@example.com",
      user_id: actor.id,
      access_type: "platform_admin",
      invited_by: "another-account",
      expires_at: now + 60_000,
      created_at: now - 60_000,
      ...options.invitation,
    })
  })

const actorRole = Effect.map(
  selectRows<{ id: string; role: string | null }>("user"),
  (users) => users.find((user) => user.id === actor.id)?.role
)

const invitationState = Effect.map(
  selectRows<{
    accepted_at: number | null
    accepted_by: string | null
    revoked_at: number | null
  }>("invitation"),
  ([invitation]) => ({
    accepted: invitation?.accepted_at != null,
    acceptedBy: invitation?.accepted_by ?? null,
    revoked: invitation?.revoked_at != null,
  })
)

const untouched = { accepted: false, acceptedBy: null, revoked: false }

describeMysql("platform invitations", () => {
  layer(TestDatabase)((it) => {
    for (const subjectId of ["another-account", null])
      it.effect(`rejects a different or unbound subject (${subjectId})`, () =>
        Effect.gen(function* () {
          yield* seed({ invitation: { user_id: subjectId } })

          const error = yield* acceptPlatformInvitationEffect(
            actor,
            tokenHash
          ).pipe(Effect.flip)

          assert.include(error.message, "invited account")
          assert.strictEqual(yield* actorRole, "user")
          assert.deepEqual(yield* invitationState, untouched)
        })
      )

    it.effect("accepts the bound identity after an email change", () =>
      Effect.gen(function* () {
        yield* seed()

        yield* acceptPlatformInvitationEffect(actor, tokenHash)

        assert.strictEqual(yield* actorRole, "admin")
        assert.deepEqual(yield* invitationState, {
          accepted: true,
          acceptedBy: actor.id,
          revoked: false,
        })
      })
    )

    for (const [lifecycle, invitation] of [
      ["expired", { expires_at: now }],
      ["accepted", { accepted_at: now - 1 }],
      ["revoked", { revoked_at: now - 1 }],
      ["declined", { declined_at: now - 1 }],
      ["cancelled", { cancelled_at: now - 1 }],
    ] as const)
      it.effect(`rejects a ${lifecycle} invitation without a role change`, () =>
        Effect.gen(function* () {
          yield* seed({ invitation })

          const error = yield* acceptPlatformInvitationEffect(
            actor,
            tokenHash
          ).pipe(Effect.flip)

          assert.include(error.message, "invalid or has expired")
          assert.strictEqual(yield* actorRole, "user")
        })
      )

    it.effect("rechecks disabled recipients before acceptance", () =>
      Effect.gen(function* () {
        yield* seed({ actorStatus: "disabled" })

        const error = yield* acceptPlatformInvitationEffect(
          actor,
          tokenHash
        ).pipe(Effect.flip)

        assert.include(error.message, "enabled, verified account is required")
        assert.strictEqual(yield* actorRole, "user")
        assert.deepEqual(yield* invitationState, untouched)
      })
    )

    for (const { label, message, ...options } of [
      {
        label: "a non-administrator",
        message: "Platform administrator required",
      },
      {
        label: "a disabled administrator",
        actorRole: "admin",
        actorStatus: "disabled",
        message: "Platform administrator required",
      },
      {
        label: "an expired invitation",
        actorRole: "admin",
        invitation: { expires_at: now },
        message: "no longer pending",
      },
    ])
      it.effect(`refuses cancellation by ${label}`, () =>
        Effect.gen(function* () {
          yield* seed(options)

          const error = yield* cancelPlatformInvitationEffect(
            actor,
            "invite"
          ).pipe(Effect.flip)

          assert.include(error.message, message)
          assert.deepEqual(yield* invitationState, untouched)
        })
      )
  })
})
