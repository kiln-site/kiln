import { expect, layer } from "@effect/vitest"
import { createHash } from "node:crypto"

import { Effect, Exit } from "effect"
import { afterEach, beforeEach, vi } from "vite-plus/test"

import {
  issueManualAccountClaim,
  redeemAccountClaim,
  redeemInvitedAccount,
  requestEmailAccountClaim,
} from "@/lib/account-claims"
import { invitationLinkKey } from "@/lib/invitation-link-key"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRows, insertUser, selectRows } from "@/test/seed"

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_message: { text: string }) => ({ error: null })),
}))
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendEmail }
  },
}))
// Better Auth only supplies the password hasher here.
vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: { hash: async () => "hashed-password" },
    }),
  },
}))

const email = "recipient@example.test"
const input = { displayName: "Recipient", password: "a-safe-password" }
const at = new Date(Date.UTC(2026, 0, 1))

interface UserRow {
  id: string
  name: string
  emailVerified: number
  emailVerifiedAt: Date | null
  manuallyVerifiedAt: Date | null
  manuallyVerifiedBy: string | null
}

const recipient = Effect.map(selectRows<UserRow>("user"), (rows) => {
  const row = rows.find((row) => row.id === "recipient")
  return {
    name: row?.name,
    emailVerified: Boolean(row?.emailVerified),
    emailVerifiedAt: row?.emailVerifiedAt !== null,
    manuallyVerifiedAt: row?.manuallyVerifiedAt !== null,
    manuallyVerifiedBy: row?.manuallyVerifiedBy,
  }
})
const passwords = Effect.map(
  selectRows<{ password: string | null; userId: string }>("account"),
  (rows) =>
    rows.filter((row) => row.userId === "recipient").map((row) => row.password)
)
const openClaims = Effect.map(
  selectRows<{ consumed_at: number | null }>("account_claim"),
  (rows) => rows.filter((row) => row.consumed_at === null).length
)

const seedRecipient = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("recipient", { email, emailVerified: false })
  yield* insertUser("admin", { role: "admin", manuallyVerifiedAt: at })
})

const credential = (password: string) =>
  insertRows("account", {
    id: "existing",
    accountId: "recipient",
    providerId: "credential",
    userId: "recipient",
    password,
    createdAt: at,
    updatedAt: at,
  })

const emailedLink = () =>
  new URL(sendEmail.mock.calls.at(-1)![0].text.match(/https:\/\/\S+/u)![0])

const issueManual = Effect.promise(() =>
  issueManualAccountClaim({ userId: "recipient", actorId: "admin" })
)

beforeEach(() => {
  sendEmail.mockClear()
  vi.stubEnv("RESEND_API_KEY", "test-only")
  vi.stubEnv("RESEND_FROM_EMAIL", "kiln@example.test")
  vi.stubEnv("KILN_URL", "https://kiln.example.test")
  vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"s".repeat(32)}`)
})
afterEach(() => vi.unstubAllEnvs())

describeMysql("credentialless identity claim", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "cannot redirect an email claim off the platform or reach an identity with credentials",
      () =>
        Effect.gen(function* () {
          yield* seedRecipient
          yield* Effect.promise(() =>
            requestEmailAccountClaim(email, "//attacker.example")
          )
          expect(emailedLink().searchParams.get("redirect")).toBe("/")

          yield* resetDatabase
          yield* insertUser("recipient", { email })
          yield* credential("existing-hash")
          sendEmail.mockClear()
          yield* Effect.promise(() => requestEmailAccountClaim(email))
          expect(sendEmail).not.toHaveBeenCalled()
          expect(yield* openClaims).toBe(0)
        })
    )

    it.effect(
      "records the manual issuer without claiming mailbox proof and redeems once",
      () =>
        Effect.gen(function* () {
          yield* seedRecipient
          const { token } = yield* issueManual

          const result = yield* Effect.promise(() =>
            redeemAccountClaim({ ...input, token })
          )

          expect(result).toEqual({ email })
          expect(yield* recipient).toEqual({
            name: "Recipient",
            emailVerified: false,
            emailVerifiedAt: false,
            manuallyVerifiedAt: true,
            manuallyVerifiedBy: "admin",
          })
          // A replayed token is refused.
          yield* Effect.flip(
            Effect.tryPromise(() => redeemAccountClaim({ ...input, token }))
          )
          expect(yield* passwords).toEqual(["hashed-password"])
        })
    )

    it.effect("never replaces an identity's existing credential", () =>
      Effect.gen(function* () {
        yield* seedRecipient
        const { token } = yield* issueManual
        // A credential added after the claim was issued wins.
        yield* credential("existing-hash")

        yield* Effect.flip(
          Effect.tryPromise(() => redeemAccountClaim({ ...input, token }))
        )

        expect(yield* passwords).toEqual(["existing-hash"])
        expect(yield* openClaims).toBe(1)
      })
    )
  })
})

const invitationId = "7d1f4b8e-2a3c-4d5e-8f90-1a2b3c4d5e6f"
const invitationToken = "t".repeat(43)

const seedInvitation = (fields: Record<string, unknown> = {}) =>
  Effect.gen(function* () {
    yield* seedRecipient
    yield* insertRows("invitation", {
      id: invitationId,
      token_hash: createHash("sha256").update(invitationToken).digest("hex"),
      email,
      user_id: "recipient",
      access_type: "relay_creator",
      invited_by: "admin",
      expires_at: Date.now() + 60_000,
      created_at: Date.now() - 60_000,
      ...fields,
    })
  })

const redeemInvitation = (
  invitation: Parameters<typeof redeemInvitedAccount>[0]["invitation"]
) => Effect.tryPromise(() => redeemInvitedAccount({ ...input, invitation }))

describeMysql("setting up an invited account from its invitation", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "takes the emailed link as proof of the mailbox, and only once",
      () =>
        Effect.gen(function* () {
          yield* seedInvitation()

          yield* Effect.flip(
            redeemInvitation({ id: invitationId, key: "k".repeat(43) })
          )
          expect(yield* passwords).toEqual([])

          const emailed = {
            id: invitationId,
            key: invitationLinkKey(invitationId, "email"),
          }
          expect(yield* redeemInvitation(emailed)).toEqual({ email })
          expect(yield* recipient).toEqual({
            name: "Recipient",
            emailVerified: true,
            emailVerifiedAt: true,
            manuallyVerifiedAt: false,
            manuallyVerifiedBy: null,
          })

          // The account now has a password, so the link sets nothing again.
          yield* Effect.flip(redeemInvitation(emailed))
          yield* Effect.flip(redeemInvitation({ token: invitationToken }))
          expect(yield* passwords).toEqual(["hashed-password"])
        })
    )

    it.effect(
      "records a copied link as the inviter's vouching and spends earlier setup links",
      () =>
        Effect.gen(function* () {
          yield* seedInvitation()
          yield* issueManual

          yield* redeemInvitation({ token: invitationToken })

          expect(yield* recipient).toEqual({
            name: "Recipient",
            emailVerified: false,
            emailVerifiedAt: false,
            manuallyVerifiedAt: true,
            manuallyVerifiedBy: "admin",
          })
          expect(yield* openClaims).toBe(0)
        })
    )

    it.effect(
      "takes the shared link as the inviter's vouching, never mailbox proof",
      () =>
        Effect.gen(function* () {
          yield* seedInvitation()

          yield* redeemInvitation({
            id: invitationId,
            key: invitationLinkKey(invitationId, "share"),
          })

          expect(yield* recipient).toEqual({
            name: "Recipient",
            emailVerified: false,
            emailVerifiedAt: false,
            manuallyVerifiedAt: true,
            manuallyVerifiedBy: "admin",
          })
        })
    )

    it.effect("refuses an invitation that is no longer open", () =>
      Effect.gen(function* () {
        yield* seedInvitation({ cancelled_at: Date.now() })
        yield* Effect.flip(redeemInvitation({ token: invitationToken }))

        yield* seedInvitation({ expires_at: Date.now() - 1 })
        yield* Effect.flip(
          redeemInvitation({
            id: invitationId,
            key: invitationLinkKey(invitationId, "email"),
          })
        )

        expect(yield* passwords).toEqual([])
      })
    )

    it.effect("sets up the account once when two requests race", () =>
      Effect.gen(function* () {
        yield* seedInvitation()
        const emailed = {
          id: invitationId,
          key: invitationLinkKey(invitationId, "email"),
        }

        const outcomes = yield* Effect.all(
          [
            Effect.exit(redeemInvitation(emailed)),
            Effect.exit(redeemInvitation({ token: invitationToken })),
          ],
          { concurrency: "unbounded" }
        )

        expect(outcomes.filter(Exit.isSuccess)).toHaveLength(1)
        expect(yield* passwords).toEqual(["hashed-password"])
      })
    )

    it.effect("never replaces an invited account's existing credential", () =>
      Effect.gen(function* () {
        yield* seedInvitation()
        yield* credential("existing-hash")

        yield* Effect.flip(redeemInvitation({ token: invitationToken }))

        expect(yield* passwords).toEqual(["existing-hash"])
      })
    )
  })
})
