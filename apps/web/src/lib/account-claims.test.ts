import { expect, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterEach, beforeEach, vi } from "vite-plus/test"

import {
  issueManualAccountClaim,
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
