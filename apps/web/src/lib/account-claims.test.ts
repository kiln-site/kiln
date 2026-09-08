import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { redeemAccountClaim } from "@/lib/account-claims"

vi.mock("@/lib/auth", () => ({
  auth: {
    $context: Promise.resolve({
      password: { hash: async () => "hashed-password" },
    }),
  },
}))
vi.mock("@/effect/runtime", () => ({
  runAppEffect: (
    _operation: string,
    effect: Effect.Effect<unknown, unknown, Database>
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer))),
}))
vi.mock("@/lib/authorization-revision", () => ({
  advanceSubjectAcrossEnabledRelaysEffect: () =>
    Effect.succeed({ relayIds: [], revision: 1 }),
}))
vi.mock("@/lib/authorization-delivery", () => ({
  wakeAuthorizationDelivery: vi.fn(),
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: vi.fn(),
}))

let consumed = false
let credential = false
let method = "manual"
let writes: Array<{ sql: string; values?: unknown[] }> = []
const claim = () => ({
  id: "claim",
  user_id: "subject",
  proof_method: method,
  created_by: "issuer",
  consumed_at: consumed ? new Date() : null,
  expires_at: new Date(Date.now() + 60_000),
})
const transaction = {
  queryRows: (sql: string) =>
    Effect.succeed(
      (sql.includes("account_claim")
        ? [claim()]
        : sql.includes("account`")
          ? credential
            ? [{ id: "credential" }]
            : []
          : [{ id: "subject", email: "recipient@example.test" }]) as never
    ),
  execute: (sql: string, values?: unknown[]) =>
    Effect.sync(() => {
      writes.push({ sql, values })
      if (sql.includes("INSERT INTO") && sql.includes("account`"))
        credential = true
      if (sql.includes("UPDATE") && sql.includes("account_claim"))
        consumed = true
      return { affectedRows: 1 } as never
    }),
}
const layer = Layer.succeed(Database)({
  queryRows: () => Effect.succeed((consumed ? [] : [{ id: "claim" }]) as never),
  execute: () => Effect.die("Expected transaction"),
  transaction: (_operation, run) => run(transaction),
})
const input = {
  token: "a".repeat(64),
  displayName: "Recipient",
  password: "a-safe-password",
}

beforeEach(() => {
  consumed = false
  credential = false
  method = "manual"
  writes = []
})

describe("credentialless identity claim", () => {
  it("records the manual issuer without claiming mailbox proof and consumes once", async () => {
    await expect(redeemAccountClaim(input)).resolves.toEqual({
      email: "recipient@example.test",
    })
    const userUpdate = writes.find((write) =>
      write.sql.includes("manuallyVerifiedAt")
    )
    expect(userUpdate?.values).toEqual(["Recipient", "issuer", "subject"])
    expect(userUpdate?.sql).not.toContain("emailVerified = TRUE")
    expect(credential).toBe(true)
    const count = writes.length
    await expect(redeemAccountClaim(input)).rejects.toThrow(
      "invalid or expired"
    )
    expect(writes).toHaveLength(count)
  })
  it("records actual email proof for an email challenge", async () => {
    method = "email"
    await redeemAccountClaim(input)
    expect(
      writes.some((write) => write.sql.includes("emailVerified = TRUE"))
    ).toBe(true)
  })
  it("never replaces an identity's existing credential", async () => {
    credential = true
    await expect(redeemAccountClaim(input)).rejects.toThrow(
      "invalid or expired"
    )
    expect(writes).toEqual([])
  })
})
