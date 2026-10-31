import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

import {
  authenticateCliTokenEffect,
  issueCliDeviceCodeEffect,
  pollCliDeviceTokenEffect,
} from "@/effect/cli-access"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { databaseTableName } from "@/lib/database-config"
import { runOperation } from "@/operations/operation"
import {
  approveCliAuthorizationOperation,
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
  })
})
