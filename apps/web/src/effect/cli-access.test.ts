import { Effect, Layer } from "effect"
import { Database } from "@/effect/database"
import { describe, expect, it } from "vite-plus/test"

import {
  authenticateCliTokenEffect,
  cliPlatformRole,
  cliRelaySubject,
  requireCliWrite,
  type CliPrincipal,
} from "@/effect/cli-access"

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

  it("preserves Bring Your Own Relays authorization", () => {
    expect(cliPlatformRole("relay_creator")).toBe("relay_creator")
    expect(cliPlatformRole("unexpected-role")).toBe("user")
  })
})

describe("CLI identity eligibility", () => {
  it("preserves the credential while disabled and resumes after enabling", async () => {
    const state = { status: "disabled", writes: [] as string[] }
    const layer = Layer.succeed(Database)({
      queryRows: () =>
        Effect.succeed([
          {
            id: principal.credentialId,
            user_id: principal.user.id,
            access_mode: "full_access",
            email: principal.user.email,
            email_verified: false,
            role: "user",
            user_name: "Agent",
            status: state.status,
            statusExpiresAt: null,
            emailVerifiedAt: null,
            manuallyVerifiedAt: new Date("2026-09-08T00:00:00Z"),
            legacyVerificationRecordedAt: null,
          },
        ] as never),
      execute: (_operation, sql) =>
        Effect.sync(() => {
          state.writes.push(sql)
          return { affectedRows: 1 } as never
        }),
      transaction: () =>
        Effect.die("Credential authentication must not mutate account state"),
    })
    const disabled = await Effect.runPromise(
      authenticateCliTokenEffect("kiln_cli_test").pipe(
        Effect.provide(layer),
        Effect.flip
      )
    )
    expect(disabled).toMatchObject({ code: "forbidden" })
    expect(state.writes).toEqual([])
    state.status = "enabled"
    const resumed = await Effect.runPromise(
      authenticateCliTokenEffect("kiln_cli_test").pipe(Effect.provide(layer))
    )
    expect(resumed.credentialId).toBe(principal.credentialId)
    expect(resumed.user.emailVerified).toBe(false)
    expect(state.writes).toHaveLength(1)
    expect(state.writes[0]).toContain("last_used_at")
  })
})
