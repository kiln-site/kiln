import { Effect, Layer } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { describe, expect, it, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { replacePendingAccountEmailEffect } from "@/lib/auth-bootstrap"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})

vi.mock("@/lib/auth", () => ({ auth: {} }))
vi.mock("@/lib/authorization-revision", () => ({
  advanceSubjectAcrossEnabledRelaysEffect: () =>
    Effect.succeed({ relayIds: [], revision: 1 }),
}))

const input = {
  userId: "pending",
  currentEmail: "old@example.test",
  nextEmail: "new@example.test",
  passwordHash: "verified-hash",
  role: "user",
}
function fixture(affectedRows: number) {
  const writes: string[] = []
  const reads: string[] = []
  const layer = Layer.succeed(Database)({
    execute: () => Effect.die("Expected transaction"),
    queryRows: () => Effect.die("Expected transaction"),
    transaction: (_operation, run) =>
      run({
        execute: (sql) =>
          Effect.sync(() => {
            writes.push(sql)
            return { affectedRows } as never
          }),
        queryRows: <T extends RowDataPacket>(sql: string) =>
          Effect.sync(() => {
            reads.push(sql)
            return [{ id: "old-session" }] as unknown as ReadonlyArray<T>
          }),
      }),
  })
  return { layer, writes, reads }
}

describe("pending email correction race", () => {
  it("rejects a stale password/verification snapshot before invalidating sessions or writing audit", async () => {
    const data = fixture(0)
    await expect(
      Effect.runPromise(
        replacePendingAccountEmailEffect(input).pipe(Effect.provide(data.layer))
      )
    ).rejects.toThrow("can no longer be changed")
    expect(data.writes).toHaveLength(1)
    expect(data.reads).toEqual([])
    // The write itself rechecks evidence, credentials and the address; it does
    // not rely on the earlier password-verification read remaining current.
    expect(data.writes[0]).toContain("u.manuallyVerifiedAt IS NULL")
    expect(data.writes[0]).toContain("u.emailVerifiedAt IS NULL")
    expect(data.writes[0]).toContain("u.legacyVerificationRecordedAt IS NULL")
    expect(data.writes[0]).toContain("a.password = ?")
  })
  it("changes the same identity and invalidates old-address sessions in its transaction", async () => {
    const data = fixture(1)
    const result = await Effect.runPromise(
      replacePendingAccountEmailEffect(input).pipe(Effect.provide(data.layer))
    )
    expect(result.sessionIds).toEqual(["old-session"])
    expect(data.writes[0]).toContain("u.id = ? AND u.email = ?")
    expect(data.writes.some((sql) => /DELETE FROM .*session/u.test(sql))).toBe(
      true
    )
    expect(
      data.writes.some((sql) => sql.includes("account.pending-email.changed"))
    ).toBe(true)
    expect(data.writes.some((sql) => /DELETE FROM \S*user`/u.test(sql))).toBe(
      false
    )
  })
})
