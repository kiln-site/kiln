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
    // Only the guarded update ran: no session lookup, deletion or audit write.
    expect(data.writes).toHaveLength(1)
    expect(data.reads).toEqual([])
  })
  it("changes the same identity and invalidates old-address sessions in its transaction", async () => {
    const data = fixture(1)
    const result = await Effect.runPromise(
      replacePendingAccountEmailEffect(input).pipe(Effect.provide(data.layer))
    )
    expect(result.sessionIds).toEqual(["old-session"])
    expect(data.writes.length).toBeGreaterThan(1)
  })
})
