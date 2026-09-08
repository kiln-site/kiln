import { Effect, Layer } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { describe, expect, it, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { transferInstanceOwnershipEffect } from "@/lib/platform-access"

vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})
vi.mock("@/lib/authorization-revision", () => ({
  advanceAuthorizationRevisionEffect: () => Effect.void,
  advanceSubjectAcrossEnabledRelaysEffect: () =>
    Effect.succeed({ relayIds: [] }),
}))

const actor: AuthenticatedUser = {
  id: "actor",
  email: "actor@example.test",
  emailVerified: false,
  emailVerifiedAt: null,
  manuallyVerifiedAt: "2026-09-08T00:00:00Z",
  legacyVerificationRecordedAt: null,
  status: "enabled",
  name: "Actor",
  role: "admin",
  isDevelopmentBypass: false,
  twoFactorEnabled: false,
}
const actorRow = {
  role: "user",
  status: "enabled",
  statusExpiresAt: null,
  emailVerifiedAt: null,
  manuallyVerifiedAt: new Date("2026-09-08T00:00:00Z"),
  legacyVerificationRecordedAt: null,
}
const input = { relayId: "relay", instanceId: "server", userId: "recipient" }
function fixture(rows: ReadonlyArray<ReadonlyArray<unknown>>) {
  let index = 0
  const reads: string[] = [],
    writes: string[] = []
  const layer = Layer.succeed(Database)({
    execute: () => Effect.die("Expected transaction"),
    queryRows: () => Effect.die("Expected transaction"),
    transaction: (_operation, run) =>
      run({
        execute: (sql) =>
          Effect.sync(() => {
            writes.push(sql)
            return { affectedRows: 1 } as never
          }),
        queryRows: <T extends RowDataPacket>(sql: string) =>
          Effect.sync(() => {
            reads.push(sql)
            if (index >= rows.length) throw new Error("Unexpected query")
            return rows[index++] as ReadonlyArray<T>
          }),
      }),
  })
  return { layer, reads, writes }
}

describe("ownership transfer fresh authority", () => {
  it("rejects a disabled actor despite an earlier eligible session", async () => {
    const data = fixture([[{ ...actorRow, status: "disabled" }]])
    await expect(
      Effect.runPromise(
        transferInstanceOwnershipEffect(actor, input).pipe(
          Effect.provide(data.layer)
        )
      )
    ).rejects.toThrow("cannot manage resource access")
    expect(data.writes).toEqual([])
  })
  it("discards an old elapsed disable expiry when the account is now indefinitely disabled", async () => {
    const data = fixture([
      [{ ...actorRow, status: "disabled", statusExpiresAt: null }],
    ])
    await expect(
      Effect.runPromise(
        transferInstanceOwnershipEffect(
          { ...actor, statusExpiresAt: "2000-01-01T00:00:00Z" },
          input
        ).pipe(Effect.provide(data.layer))
      )
    ).rejects.toThrow("cannot manage resource access")
    expect(data.reads).toHaveLength(1)
    expect(data.writes).toEqual([])
  })

  it("rejects a demoted administrator who does not currently own the instance", async () => {
    const data = fixture([
      [actorRow],
      [{ name: "Relay", owner_id: "someone" }],
      [{ name: "Server", owner_id: "owner" }],
    ])
    await expect(
      Effect.runPromise(
        transferInstanceOwnershipEffect(actor, input).pipe(
          Effect.provide(data.layer)
        )
      )
    ).rejects.toThrow("Only the server owner")
    expect(data.writes).toEqual([])
    expect(data.reads[0]).toContain("user")
    expect(data.reads[1]).toContain("relay")
    expect(data.reads[2]).toContain("instance")
    expect(data.reads.every((sql) => sql.includes("FOR UPDATE"))).toBe(true)
  })
  it("locks actor then Relay then instance before transferring current owner authority", async () => {
    const data = fixture([
      [actorRow],
      [{ name: "Relay", owner_id: "someone" }],
      [{ name: "Server", owner_id: actor.id }],
      [{ ...actorRow, id: "recipient" }],
      [{ user_id: "recipient" }],
    ])
    const result = await Effect.runPromise(
      transferInstanceOwnershipEffect(actor, input).pipe(
        Effect.provide(data.layer)
      )
    )
    expect(result).toEqual({ transferred: true, previousOwnerId: actor.id })
    expect(data.reads[0]).toContain("user")
    expect(data.reads[1]).toContain("relay")
    expect(data.reads[2]).toContain("instance")
    expect(data.reads[4]).toContain("state = 'active'")
    expect(
      data.writes.some((sql) => sql.includes("ownership.transferred"))
    ).toBe(true)
    expect(data.writes.some((sql) => sql.includes("access_grant"))).toBe(false)
  })
})
