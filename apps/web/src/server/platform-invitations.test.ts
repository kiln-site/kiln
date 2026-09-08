import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import type { ResultSetHeader, RowDataPacket } from "mysql2/promise"
import { vi } from "vite-plus/test"
vi.hoisted(() => {
  process.env.DB_HOST ??= "127.0.0.1"
  process.env.DB_NAME ??= "test"
  process.env.DB_PASSWORD ??= "test"
  process.env.DB_USERNAME ??= "test"
})
import { Database } from "@/effect/database"
import type { AuthenticatedUser } from "@/lib/auth-session"
import {
  acceptPlatformInvitationEffect,
  cancelPlatformInvitationEffect,
} from "@/lib/platform-access"
const actor = {
  id: "original",
  email: "changed@example.com",
  role: "user",
  isDevelopmentBypass: false,
} as AuthenticatedUser
function fixture(
  options: {
    subjectId?: string | null
    status?: string
    lifecycle?: string
    admin?: boolean
  } = {}
) {
  const writes: string[] = []
  const invitation = {
    id: "invite",
    user_id: options.subjectId === undefined ? actor.id : options.subjectId,
    email: "old@example.com",
    access_type: "platform_admin",
    expires_at: new Date(Date.now() + 60_000),
    ...(options.lifecycle === "expired"
      ? { expires_at: new Date(0) }
      : options.lifecycle
        ? { [options.lifecycle]: new Date() }
        : {}),
  }
  const layer = Layer.succeed(Database)({
    execute: () => Effect.die("Standalone write"),
    queryRows: () => Effect.die("Standalone query"),
    transaction: (_operation, run) =>
      run({
        execute: (sql) =>
          Effect.sync(() => {
            writes.push(sql)
            return { affectedRows: 1 } as ResultSetHeader
          }),
        queryRows: <T extends RowDataPacket>(sql: string) =>
          Effect.succeed(
            (sql.includes("WHERE role = 'admin'")
              ? options.admin
                ? [
                    {
                      ...actor,
                      role: "admin",
                      emailVerifiedAt: new Date(0),
                      status: options.status ?? "enabled",
                    },
                  ]
                : []
              : sql.includes("invitation")
                ? [invitation]
                : sql.includes("WHERE id = ?")
                  ? [
                      {
                        ...actor,
                        emailVerifiedAt: new Date(0),
                        status: options.status ?? "enabled",
                      },
                    ]
                  : []) as unknown as ReadonlyArray<T>
          ),
      }),
  })
  return { writes, layer }
}
describe("platform invitations", () => {
  for (const subjectId of ["another-account", null])
    it.effect(`rejects a different or unbound subject (${subjectId})`, () => {
      const { writes, layer } = fixture({ subjectId })
      return Effect.gen(function* () {
        const error = yield* acceptPlatformInvitationEffect(actor, "hash").pipe(
          Effect.flip
        )
        assert.include(error.message, "invited account")
        assert.lengthOf(writes, 0)
      }).pipe(Effect.provide(layer))
    })
  it.effect("accepts the bound identity after an email change", () => {
    const { writes, layer } = fixture()
    return Effect.gen(function* () {
      yield* acceptPlatformInvitationEffect(actor, "hash")
      assert.isTrue(writes.some((sql) => sql.includes("accepted_by")))
    }).pipe(Effect.provide(layer))
  })
  for (const lifecycle of [
    "expired",
    "accepted_at",
    "revoked_at",
    "declined_at",
    "cancelled_at",
  ])
    it.effect(`rejects ${lifecycle} without a role write`, () => {
      const { writes, layer } = fixture({ lifecycle })
      return Effect.gen(function* () {
        yield* acceptPlatformInvitationEffect(actor, "hash").pipe(Effect.flip)
        assert.lengthOf(writes, 0)
      }).pipe(Effect.provide(layer))
    })
  it.effect("rechecks disabled recipients before acceptance", () => {
    const { writes, layer } = fixture({ status: "disabled" })
    return Effect.gen(function* () {
      yield* acceptPlatformInvitationEffect(actor, "hash").pipe(Effect.flip)
      assert.lengthOf(writes, 0)
    }).pipe(Effect.provide(layer))
  })
  for (const options of [
    { admin: false },
    { admin: true, status: "disabled" },
    { admin: true, lifecycle: "expired" },
  ])
    it.effect(`refuses cancellation with ${JSON.stringify(options)}`, () => {
      const { writes, layer } = fixture(options)
      return Effect.gen(function* () {
        yield* cancelPlatformInvitationEffect(actor, "invite").pipe(Effect.flip)
        assert.lengthOf(writes, 0)
      }).pipe(Effect.provide(layer))
    })
})
