import { createHash, randomBytes } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import {
  authenticateCliTokenEffect,
  issueCliDeviceCodeEffect,
  pollCliDeviceTokenEffect,
  redeemMobileSignInEffect,
} from "@/effect/cli-access"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTableName } from "@/lib/database-config"
import { runOperation } from "@/operations/operation"
import {
  approveCliAuthorizationOperation,
  authorizeMobileSignInOperation,
  denyCliAuthorizationOperation,
  revokeCliCredentialOperation,
} from "@/server/account-access.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser, selectRows } from "@/test/seed"

// Before the imports below load Better Auth, which reads it.
vi.hoisted(() => vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`))

const now = Date.UTC(2026, 9, 31)
const verifiedAt = new Date("2026-10-30T00:00:00Z")

// A person as their request saw them, signed in and eligible.
const person = (id: string, role: "admin" | "user" = "user") =>
  ({
    email: `${id}@example.test`,
    emailVerified: true,
    id,
    isDevelopmentBypass: false,
    manuallyVerifiedAt: verifiedAt.toISOString(),
    name: id,
    role,
    status: "enabled",
    twoFactorEnabled: false,
  }) satisfies AuthenticatedUser

const seedPeople = (...ids: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* TestClock.setTime(now)
    for (const id of ids) {
      yield* insertUser(id, { manuallyVerifiedAt: verifiedAt })
    }
  })

const requestCli = issueCliDeviceCodeEffect({
  baseUrl: new URL("https://hearth.example.test"),
  ipAddress: null,
  name: "Agent CLI",
  userAgent: null,
})

const approve = (user: AuthenticatedUser, userCode: string) =>
  runOperation(
    approveCliAuthorizationOperation,
    { duration: "1d", mode: "full_access", userCode },
    { user }
  )

// What the Kiln app does: keep a verifier, sign in with its hash.
const signInPhone = (user: AuthenticatedUser) =>
  Effect.gen(function* () {
    const verifier = randomBytes(32).toString("base64url")
    const challenge = createHash("sha256").update(verifier).digest("hex")
    const { code } = yield* runOperation(
      authorizeMobileSignInOperation,
      { challenge, name: "iPhone" },
      { user }
    )
    return { code, verifier }
  })

const errorCode = (error: unknown) => (error as { code?: string }).code

describeMysql("account access operations", () => {
  layer(TestDatabase)((it) => {
    it.effect("an account disabled meanwhile can't link a CLI", () =>
      Effect.gen(function* () {
        yield* seedPeople("alice")
        const device = yield* requestCli
        // Disabled after the request read the account, before it ran.
        const sql = yield* SqlClient.SqlClient
        yield* sql`UPDATE ${sql(databaseTableName("user"))} SET status = 'disabled' WHERE id = 'alice'`

        const refused = yield* approve(person("alice"), device.userCode).pipe(
          Effect.flip
        )

        assert.isDefined(refused)
        assert.deepStrictEqual(yield* selectRows("cli_credential"), [])
        const [request] = yield* selectRows<{ status: string }>("cli_device")
        assert.strictEqual(request?.status, "pending")
      })
    )

    it.effect("two people answering one CLI request decide it once", () =>
      Effect.gen(function* () {
        yield* seedPeople("alice", "bob")
        const device = yield* requestCli

        const [approved, denied] = yield* Effect.all(
          [
            approve(person("alice"), device.userCode).pipe(Effect.result),
            runOperation(
              denyCliAuthorizationOperation,
              { userCode: device.userCode },
              { user: person("bob") }
            ).pipe(Effect.result),
          ],
          { concurrency: "unbounded" }
        )

        const decided = [approved, denied].filter(
          (result) => result._tag === "Success"
        )
        assert.strictEqual(decided.length, 1)
        const credentials = yield* selectRows<{ user_id: string }>(
          "cli_credential"
        )
        const [request] = yield* selectRows<{ status: string }>("cli_device")
        if (approved._tag === "Success") {
          assert.strictEqual(request?.status, "approved")
          assert.deepStrictEqual(
            credentials.map(({ user_id }) => user_id),
            ["alice"]
          )
        } else {
          assert.strictEqual(request?.status, "denied")
          assert.deepStrictEqual(credentials, [])
        }
      })
    )

    it.effect("only its owner can unlink a CLI, which then stops working", () =>
      Effect.gen(function* () {
        yield* seedPeople("alice", "root")
        const device = yield* requestCli
        const { credentialId } = yield* approve(
          person("alice"),
          device.userCode
        )
        const { accessToken } = yield* pollCliDeviceTokenEffect(
          device.deviceCode
        )

        // Not even an administrator unlinks another person's CLI.
        const foreign = yield* runOperation(
          revokeCliCredentialOperation,
          { credentialId },
          { user: person("root", "admin") }
        ).pipe(Effect.flip)
        assert.strictEqual((foreign as { code?: string }).code, "not_found")
        const still = yield* authenticateCliTokenEffect(accessToken)
        assert.strictEqual(still.credentialId, credentialId)

        yield* runOperation(
          revokeCliCredentialOperation,
          { credentialId },
          { user: person("alice") }
        )
        const revoked = yield* authenticateCliTokenEffect(accessToken).pipe(
          Effect.flip
        )
        assert.isDefined(revoked)
      })
    )

    it.effect("a phone's sign-in code links nothing without its verifier", () =>
      Effect.gen(function* () {
        yield* seedPeople("alice")
        const { code, verifier } = yield* signInPhone(person("alice"))

        // Whoever saw the redirect has the code, but not the phone's verifier.
        const stolen = yield* redeemMobileSignInEffect({
          code,
          verifier: randomBytes(32).toString("base64url"),
        }).pipe(Effect.flip)
        assert.strictEqual(errorCode(stolen), "invalid_grant")
        // The attempt burns the code, so the phone signs in again.
        const late = yield* redeemMobileSignInEffect({ code, verifier }).pipe(
          Effect.flip
        )
        assert.strictEqual(errorCode(late), "invalid_grant")
        assert.deepStrictEqual(yield* selectRows("cli_credential"), [])
      })
    )

    it.effect(
      "a phone redeems its sign-in once, for a working credential",
      () =>
        Effect.gen(function* () {
          yield* seedPeople("alice")
          const { code, verifier } = yield* signInPhone(person("alice"))

          const { accessToken, credential } = yield* redeemMobileSignInEffect({
            code,
            verifier,
          })
          const principal = yield* authenticateCliTokenEffect(accessToken)
          assert.strictEqual(principal.user.id, "alice")
          assert.strictEqual(principal.credentialId, credential.id)

          const again = yield* redeemMobileSignInEffect({
            code,
            verifier,
          }).pipe(Effect.flip)
          assert.strictEqual(errorCode(again), "invalid_grant")
          assert.strictEqual((yield* selectRows("cli_credential")).length, 1)
        })
    )

    it.effect("a phone's sign-in left waiting expires", () =>
      Effect.gen(function* () {
        yield* seedPeople("alice")
        const { code, verifier } = yield* signInPhone(person("alice"))
        yield* TestClock.adjust("3 minutes")

        const expired = yield* redeemMobileSignInEffect({
          code,
          verifier,
        }).pipe(Effect.flip)
        assert.strictEqual(errorCode(expired), "invalid_grant")
        assert.deepStrictEqual(yield* selectRows("cli_credential"), [])
      })
    )

    it.effect("the development shortcut can't sign in the app", () =>
      Effect.gen(function* () {
        yield* seedPeople("alice")
        const refused = yield* signInPhone({
          ...person("alice"),
          isDevelopmentBypass: true,
        }).pipe(Effect.flip)

        assert.strictEqual(errorCode(refused), "forbidden")
        assert.deepStrictEqual(yield* selectRows("cli_device"), [])
      })
    )
  })
})
