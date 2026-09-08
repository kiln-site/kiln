import { createHash } from "node:crypto"
import { Effect, Layer } from "effect"
import { beforeEach, describe, expect, it, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import {
  previewAccountClaim,
  redeemAccountClaim,
  requestEmailAccountClaim,
} from "@/lib/account-claims"

const { sendEmail } = vi.hoisted(() => ({
  sendEmail: vi.fn(async (_message: { text: string }) => ({ error: null })),
}))
vi.mock("resend", () => ({
  Resend: class {
    emails = { send: sendEmail }
  },
}))
vi.mock("@/lib/environment", () => ({
  emailDeliveryConfig: () => ({
    apiKey: "test-only",
    from: "kiln@example.test",
  }),
  kilnPublicUrl: () => "https://kiln.example.test",
}))

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

let preview: Record<string, unknown> | null = null
let previewQuery: { sql: string; values: unknown } | null = null
let consumed = false
let credential = false
let method = "manual"
let writes: Array<{ sql: string; values?: unknown[] }> = []
const claim = () => ({
  id: "claim",
  user_id: "subject",
  proof_method: method,
  created_by: "issuer",
  created_at: new Date(Date.now() - 120_000),
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
      if (sql.includes("INSERT INTO") && sql.includes("account_claim"))
        consumed = false
      return { affectedRows: 1 } as never
    }),
}
const layer = Layer.succeed(Database)({
  queryRows: (operation, sql, values) => {
    if (operation === "account.claim.preview") previewQuery = { sql, values }
    return Effect.succeed(
      (operation === "account.claim.preview"
        ? preview
          ? [preview]
          : []
        : consumed
          ? []
          : [{ id: "claim" }]) as never
    )
  },
  execute: () => Effect.die("Expected transaction"),
  transaction: (_operation, run) => run(transaction),
})
const input = {
  token: "a".repeat(64),
  displayName: "Recipient",
  password: "a-safe-password",
}

beforeEach(() => {
  preview = null
  previewQuery = null
  consumed = false
  credential = false
  method = "manual"
  writes = []
  sendEmail.mockClear()
})

describe("credentialless identity claim", () => {
  it("emails a verification challenge that preserves the invitation destination across browsers", async () => {
    method = "email"
    await requestEmailAccountClaim(
      "recipient@example.test",
      "/invite?id=2a226644-998c-449a-b574-971b22a722d3"
    )
    expect(sendEmail).toHaveBeenCalledOnce()
    const link = new URL(
      sendEmail.mock.calls[0]![0].text.match(/https:\/\/\S+/u)![0]
    )
    expect(link.pathname).toBe("/claim")
    expect(link.searchParams.get("redirect")).toBe(
      "/invite?id=2a226644-998c-449a-b574-971b22a722d3"
    )
    expect(link.searchParams.get("token")).toMatch(/^[a-f\d]{64}$/u)
    expect(credential).toBe(false)
    await redeemAccountClaim({
      ...input,
      token: link.searchParams.get("token")!,
    })
    expect(credential).toBe(true)
    expect(
      writes.some((write) => write.sql.includes("emailVerified = TRUE"))
    ).toBe(true)
    expect(
      writes.some(
        (write) =>
          write.sql.includes("UPDATE") && write.sql.includes("invitation")
      )
    ).toBe(false)
  })
  it("cannot redirect an email claim off the platform or replace existing credentials", async () => {
    method = "email"
    await requestEmailAccountClaim(
      "recipient@example.test",
      "//attacker.example"
    )
    const link = new URL(
      sendEmail.mock.calls[0]![0].text.match(/https:\/\/\S+/u)![0]
    )
    expect(link.searchParams.get("redirect")).toBe("/")
    sendEmail.mockClear()
    credential = true
    await requestEmailAccountClaim("recipient@example.test")
    expect(sendEmail).not.toHaveBeenCalled()
  })
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

describe("claim email preview", () => {
  const valid = () => ({
    email: "recipient@example.test",
    consumed_at: null,
    expires_at: new Date(Date.now() + 60_000),
    hasCredential: 0,
  })
  it("returns only the address without consuming or verifying the claim", async () => {
    preview = valid()
    await expect(previewAccountClaim(input.token)).resolves.toEqual({
      email: "recipient@example.test",
    })
    expect(previewQuery?.sql).toContain("WHERE c.token_hash = ?")
    expect(previewQuery?.values).toEqual([
      createHash("sha256").update(input.token).digest("hex"),
    ])
    expect(writes).toEqual([])
    expect(credential).toBe(false)
  })
  it("does not disclose an address for malformed or missing tokens", async () => {
    await expect(previewAccountClaim(input.token)).resolves.toBeNull()
    preview = valid()
    await expect(previewAccountClaim("invalid")).resolves.toBeNull()
  })
  it.each([
    { consumed_at: new Date() },
    { expires_at: new Date(0) },
    { hasCredential: 1 },
  ])("does not disclose unavailable claims: %o", async (unavailable) => {
    preview = { ...valid(), ...unavailable }
    await expect(previewAccountClaim(input.token)).resolves.toBeNull()
    expect(writes).toEqual([])
  })
})
