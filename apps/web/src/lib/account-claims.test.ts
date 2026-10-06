import { createHash } from "node:crypto"

import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, vi } from "vite-plus/test"

import {
  issueManualAccountClaim,
  previewAccountClaim,
  redeemAccountClaim,
  requestEmailAccountClaim,
} from "@/lib/account-claims"
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
})
afterEach(() => vi.unstubAllEnvs())

describeMysql("credentialless identity claim", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "emails a verification challenge that keeps the invitation destination and proves the mailbox once redeemed",
      () =>
        Effect.gen(function* () {
          yield* seedRecipient
          yield* insertRows("invitation", {
            id: "invitation",
            token_hash: "f".repeat(64),
            email,
            user_id: "recipient",
            invited_by: "admin",
            expires_at: Date.now() + 60_000,
            created_at: 0,
          })

          yield* Effect.promise(() =>
            requestEmailAccountClaim(
              email,
              "/invite?id=2a226644-998c-449a-b574-971b22a722d3"
            )
          )
          expect(sendEmail).toHaveBeenCalledOnce()
          const link = emailedLink()
          expect(link.origin + link.pathname).toBe(
            "https://kiln.example.test/claim"
          )
          expect(link.searchParams.get("redirect")).toBe(
            "/invite?id=2a226644-998c-449a-b574-971b22a722d3"
          )
          expect(yield* passwords).toEqual([])

          yield* Effect.promise(() =>
            redeemAccountClaim({
              ...input,
              token: link.searchParams.get("token")!,
            })
          )

          expect(yield* passwords).toEqual(["hashed-password"])
          expect(yield* recipient).toEqual({
            name: "Recipient",
            emailVerified: true,
            emailVerifiedAt: true,
            manuallyVerifiedAt: false,
            manuallyVerifiedBy: null,
          })
          const invitations = yield* selectRows<{
            accepted_at: number | null
          }>("invitation")
          expect(invitations.map((row) => row.accepted_at)).toEqual([null])
        })
    )

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
          const replay = yield* Effect.flip(
            Effect.tryPromise(() => redeemAccountClaim({ ...input, token }))
          )
          expect(String(replay.cause)).toContain("invalid or expired")
          expect(yield* passwords).toEqual(["hashed-password"])
        })
    )

    it.effect("never replaces an identity's existing credential", () =>
      Effect.gen(function* () {
        yield* seedRecipient
        const { token } = yield* issueManual
        // A credential added after the claim was issued wins.
        yield* credential("existing-hash")

        const error = yield* Effect.flip(
          Effect.tryPromise(() => redeemAccountClaim({ ...input, token }))
        )

        expect(String(error.cause)).toContain("invalid or expired")
        expect(yield* passwords).toEqual(["existing-hash"])
        expect(yield* openClaims).toBe(1)
      })
    )
  })
})

describeMysql("claim email preview", () => {
  layer(TestDatabase)((it) => {
    const token = "a".repeat(64)
    const seedClaim = (
      claim: { consumed_at?: number; expires_at?: number } = {}
    ) =>
      Effect.gen(function* () {
        yield* seedRecipient
        yield* insertRows("account_claim", {
          id: "claim",
          user_id: "recipient",
          token_hash: createHash("sha256").update(token).digest("hex"),
          proof_method: "email",
          expires_at: Date.now() + 60_000,
          created_at: 0,
          ...claim,
        })
      })
    const preview = (value: string) =>
      Effect.promise(() => previewAccountClaim(value))

    it.effect(
      "returns only the address without consuming or verifying the claim",
      () =>
        Effect.gen(function* () {
          yield* seedClaim()

          expect(yield* preview(token)).toEqual({ email })
          expect(yield* openClaims).toBe(1)
          expect((yield* recipient).emailVerifiedAt).toBe(false)
        })
    )

    it.effect(
      "does not disclose an address for malformed or unknown tokens",
      () =>
        Effect.gen(function* () {
          yield* seedClaim()
          expect(yield* preview("b".repeat(64))).toBeNull()
          expect(yield* preview("invalid")).toBeNull()
        })
    )

    it.effect("does not disclose unavailable claims", () =>
      Effect.gen(function* () {
        yield* seedClaim({ consumed_at: 1 })
        expect(yield* preview(token)).toBeNull()
        yield* seedClaim({ expires_at: 1 })
        expect(yield* preview(token)).toBeNull()
        yield* seedClaim()
        yield* credential("existing-hash")
        expect(yield* preview(token)).toBeNull()
      })
    )
  })
})
