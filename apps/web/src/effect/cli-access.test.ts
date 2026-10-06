import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { describe, expect, it, vi } from "vite-plus/test"

import {
  approveCliAuthorizationEffect,
  authenticateCliTokenEffect,
  cliRelaySubject,
  issueCliDeviceCodeEffect,
  pollCliDeviceTokenEffect,
  requireCliWrite,
  type CliPrincipal,
} from "@/effect/cli-access"
import { CliAccessError } from "@/effect/errors"
import { databaseTableName } from "@/lib/database-config"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser, selectRows } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

const principal: CliPrincipal = {
  credentialId: "12345678-1234-4123-8123-123456789abc",
  mode: "full_access",
  user: {
    email: "agent@example.test",
    emailVerified: true,
    id: "user-123",
    isDevelopmentBypass: false,
    name: "Agent",
    role: "user",
    twoFactorEnabled: false,
  },
}

describe("CLI access enforcement", () => {
  it("allows mutations for full-access credentials", async () => {
    await expect(Effect.runPromise(requireCliWrite(principal))).resolves.toBe(
      undefined
    )
  })

  it("blocks mutations for read-only credentials with a typed error", async () => {
    const error = await Effect.runPromise(
      requireCliWrite({ ...principal, mode: "read_only" }).pipe(Effect.flip)
    )

    expect(error).toMatchObject({
      _tag: "CliAccessError",
      code: "forbidden",
      retryable: false,
    })
  })

  it("encodes both the credential and owning user in Relay attribution", () => {
    expect(cliRelaySubject(principal)).toBe(
      "cli/12345678-1234-4123-8123-123456789abc/user-123"
    )
  })
})

const now = Date.UTC(2026, 8, 9)
const manuallyVerifiedAt = new Date("2026-09-08T00:00:00Z")

// Links a CLI through the device flow the way `kiln login` does.
const linkCli = Effect.gen(function* () {
  const device = yield* issueCliDeviceCodeEffect({
    baseUrl: new URL("https://hearth.example.test"),
    ipAddress: null,
    name: "Agent CLI",
    userAgent: null,
  })
  const { credentialId } = yield* approveCliAuthorizationEffect({
    duration: "1d",
    mode: "full_access",
    user: {
      ...principal.user,
      emailVerified: false,
      manuallyVerifiedAt: manuallyVerifiedAt.toISOString(),
    },
    userCode: device.userCode,
  })
  const { accessToken } = yield* pollCliDeviceTokenEffect(device.deviceCode)
  return { accessToken, credentialId }
})

const setUserStatus = (status: "enabled" | "disabled") =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    yield* sql`UPDATE ${sql(databaseTableName("user"))} SET status = ${status} WHERE id = ${principal.user.id}`
  })

describeMysql("CLI identity eligibility", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "preserves the credential while disabled and resumes after enabling",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* TestClock.setTime(now)
          yield* insertUser(principal.user.id, {
            emailVerified: false,
            manuallyVerifiedAt,
          })
          const { accessToken, credentialId } = yield* linkCli
          yield* setUserStatus("disabled")

          const disabled = yield* authenticateCliTokenEffect(accessToken).pipe(
            Effect.flip
          )

          assert.instanceOf(disabled, CliAccessError)
          assert.strictEqual((disabled as CliAccessError).code, "forbidden")
          const [stored] = yield* selectRows<{
            id: string
            last_used_at: number | null
            revoked_at: number | null
          }>("cli_credential")
          assert.deepInclude(stored, {
            id: credentialId,
            last_used_at: null,
            revoked_at: null,
          })

          yield* setUserStatus("enabled")
          const resumed = yield* authenticateCliTokenEffect(accessToken)

          assert.strictEqual(resumed.credentialId, credentialId)
          assert.isFalse(resumed.user.emailVerified)
          const [used] = yield* selectRows<{ last_used_at: number | null }>(
            "cli_credential"
          )
          assert.strictEqual(Number(used?.last_used_at), now)
        })
    )
  })
})
