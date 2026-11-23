import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertBackupStorage,
  insertRows,
  insertUser,
} from "@/test/seed"

import {
  acknowledgeRecoveryCode,
  recoveryCodeStatus,
  revealRecoveryCode,
} from "./recovery-code.server"

// Kiln's recovery code opens every backup of Kiln: only a fresh second factor
// shows it, but to the administrator just setting Kiln up.

const people = vi.hoisted(() => ({
  current: null as AuthenticatedUser | null,
}))
vi.mock("@/server/auth", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/auth")>()),
  requireEligibleResourceUser: async () => people.current,
}))

// Better Auth checks codes against the account's two-factor record; here,
// one authenticator code and one single-use backup code are right.
const codes = vi.hoisted(() => ({ backupUsed: false, checked: 0 }))
vi.mock("@/lib/auth", () => {
  const wrong = () =>
    Object.assign(new Error("Invalid code"), { status: "UNAUTHORIZED" })
  return {
    auth: {
      api: {
        verifyTOTP: async ({ body }: { body: { code: string } }) => {
          codes.checked += 1
          if (body.code !== "123456") throw wrong()
          return { token: "session" }
        },
        verifyBackupCode: async ({ body }: { body: { code: string } }) => {
          codes.checked += 1
          if (body.code !== "abcde-fghij" || codes.backupUsed) throw wrong()
          codes.backupUsed = true
          return { token: "session" }
        },
      },
    },
  }
})

// The Relay hosting Kiln, which reports this installation and holds its
// recovery code.
const relay = vi.hoisted(() => ({ reads: 0 }))
vi.mock("@/server/platform-access.server", () => ({
  kilnPlatformHosts: async () => [
    {
      error: null,
      relayId: "relay-a",
      relayName: "Relay A",
      status: { installationId: "kiln-test", recovery: "environment" },
    },
  ],
  platformRelay: async (relayId: string) => ({ id: relayId }),
}))
vi.mock("@/lib/relay-connection", () => ({
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation !== "relay.platform.recovery.read") {
      throw new Error(`Unexpected ${operation}`)
    }
    relay.reads += 1
    return {
      code: "kiln-rk-platform-backup-key",
      installationId: "kiln-test",
      scope: "environment",
    }
  },
}))

const administrator = (
  twoFactorEnabled: boolean,
  id = "admin"
): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  id,
  isDevelopmentBypass: false,
  name: "Admin",
  role: "admin",
  status: "enabled",
  twoFactorEnabled,
})

// Kiln set up `age` ago, by its only account.
const setUp = (age: number) =>
  Effect.gen(function* () {
    yield* resetDatabase
    yield* insertUser("admin", { createdAt: new Date(Date.now() - age) })
    codes.backupUsed = false
    codes.checked = 0
    relay.reads = 0
    people.current = administrator(false)
  })

const minutes = 60 * 1000
// Long since set up, with other people on it.
const seed = Effect.gen(function* () {
  yield* setUp(60 * minutes)
  yield* insertUser("other-admin")
  yield* insertUser("member")
})

const reveal = (code: string | null) =>
  Effect.promise(() =>
    revealRecoveryCode(code, new Headers()).then(
      (shown) => ({ shown, refused: null }),
      (cause: unknown) => ({
        refused: cause instanceof Error ? cause.message : String(cause),
        shown: null,
      })
    )
  )

describeMysql("recovery code", () => {
  layer(TestDatabase)((it) => {
    it.effect("shows it without a code while Kiln is being set up", () =>
      Effect.gen(function* () {
        yield* setUp(5 * minutes)

        // Again too, as when the page reloads, until it's saved.
        assert.strictEqual(
          (yield* reveal(null)).shown?.code,
          "kiln-rk-platform-backup-key"
        )
        assert.strictEqual((yield* reveal(null)).shown?.scope, "environment")
        yield* Effect.promise(() => acknowledgeRecoveryCode())
        assert.include((yield* reveal(null)).refused, "two-factor")
      })
    )

    it.effect("asks for a code on a Kiln set up before, shown or not", () =>
      Effect.gen(function* () {
        yield* setUp(31 * minutes)
        assert.include((yield* reveal(null)).refused, "two-factor")

        // Nor to someone new on it, or once there's someone else.
        yield* setUp(60 * minutes)
        yield* insertUser("other-admin", { createdAt: new Date() })
        people.current = administrator(false, "other-admin")
        assert.include((yield* reveal(null)).refused, "two-factor")
        yield* setUp(5 * minutes)
        yield* insertUser("other-admin")
        assert.include((yield* reveal(null)).refused, "two-factor")
      })
    )

    it.effect("takes a right second factor, and each backup code once", () =>
      Effect.gen(function* () {
        yield* seed

        // A missing or wrong code is refused before the Relay is asked.
        people.current = administrator(true)
        assert.isNull((yield* reveal(null)).shown)
        assert.isNull((yield* reveal("654321")).shown)
        assert.strictEqual(relay.reads, 0)
        assert.strictEqual(
          (yield* reveal("123456")).shown?.scope,
          "environment"
        )

        assert.strictEqual(
          (yield* reveal("abcde-fghij")).shown?.scope,
          "environment"
        )
        assert.isNull((yield* reveal("abcde-fghij")).shown)
      })
    )

    it.effect("stops checking codes after too many wrong ones", () =>
      Effect.gen(function* () {
        yield* seed
        people.current = administrator(true, "other-admin")
        for (let attempt = 0; attempt < 5; attempt += 1) {
          assert.include((yield* reveal("000000")).refused, "didn't match")
        }
        const checked = codes.checked
        const blocked = yield* reveal("123456")
        assert.isNull(blocked.shown)
        assert.include(blocked.refused, "Too many wrong codes")
        assert.strictEqual(codes.checked, checked)
      })
    )

    it.effect(
      "counts only a backup the code restores, kept off this machine",
      () =>
        Effect.gen(function* () {
          yield* seed
          const status = () => Effect.promise(() => recoveryCodeStatus())
          const platformBackup = (
            id: string,
            recoverable: boolean,
            storageId: string | null
          ) =>
            Effect.gen(function* () {
              yield* insertBackup(id, {
                artifact_kind: "platform_bundle",
                completed_at: Date.parse("2026-11-01T00:00:00.000Z"),
                recoverable,
                target_id: "kiln-test",
                target_kind: "platform",
              })
              yield* insertRows("backup_artifact", {
                backup_id: id,
                created_at: Date.parse("2026-11-01T00:00:00.000Z"),
                destination_key: storageId ?? "local",
                id: `${id.slice(0, -2)}a${id.slice(-1)}`,
                status: "available",
                storage_id: storageId,
                updated_at: Date.parse("2026-11-01T00:00:00.000Z"),
              })
            })
          yield* insertBackupStorage("00000000-0000-4000-8000-0000000000b1")

          // Only on this machine's disk, or format 1: neither restores Kiln
          // on a new machine with the code.
          yield* platformBackup(
            "00000000-0000-4000-8000-000000000001",
            true,
            null
          )
          yield* platformBackup(
            "00000000-0000-4000-8000-000000000002",
            false,
            "00000000-0000-4000-8000-0000000000b1"
          )
          assert.isNull((yield* status()).recoverableBackup)

          yield* platformBackup(
            "00000000-0000-4000-8000-000000000003",
            true,
            "00000000-0000-4000-8000-0000000000b1"
          )
          assert.deepStrictEqual((yield* status()).recoverableBackup, {
            at: Date.parse("2026-11-01T00:00:00.000Z"),
          })
        })
    )

    it.effect("shows it only to platform administrators", () =>
      Effect.gen(function* () {
        yield* seed
        people.current = { ...administrator(true), id: "member", role: "user" }
        assert.isNull((yield* reveal(null)).shown)
        assert.strictEqual(relay.reads, 0)
      })
    )
  })
})

afterAll(() => disposeAppRuntime())
