import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertUser } from "@/test/seed"

import {
  acknowledgeRecoveryKit,
  revealRecoveryKit,
} from "./recovery-kit.server"

// Kiln's recovery kit opens everything Kiln holds: past its first showing,
// only a fresh second factor shows it again.

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
// recovery key.
const relay = vi.hoisted(() => ({ reads: 0 }))
vi.mock("@/server/platform-access.server", () => ({
  kilnPlatformHosts: async () => [
    {
      error: null,
      relayId: "relay-a",
      relayName: "Relay A",
      status: { installationId: "kiln-test", recovery: "key" },
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
      installationId: "kiln-test",
      kind: "key",
      platformBackupKey: "platform-backup-key",
    }
  },
}))

const administrator = (twoFactorEnabled: boolean): AuthenticatedUser => ({
  email: "admin@example.test",
  emailVerified: true,
  id: "admin",
  isDevelopmentBypass: false,
  name: "Admin",
  role: "admin",
  status: "enabled",
  twoFactorEnabled,
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertUser("admin")
  yield* insertUser("member")
  codes.backupUsed = false
  codes.checked = 0
  relay.reads = 0
  people.current = administrator(false)
})

const reveal = (code: string | null) =>
  Effect.promise(() =>
    revealRecoveryKit(code, new Headers()).then(
      (shown) => ({ shown, refused: null }),
      (cause: unknown) => ({
        refused: cause instanceof Error ? cause.message : String(cause),
        shown: null,
      })
    )
  )

describeMysql("recovery kit", () => {
  layer(TestDatabase)((it) => {
    it.effect("shows the kit once without a code, then only with one", () =>
      Effect.gen(function* () {
        yield* seed

        // The first showing ever: the administrator who just set Kiln up,
        // before they could have turned on two-factor authentication.
        const first = yield* reveal(null)
        assert.strictEqual(first.shown?.kind, "key")
        assert.match(first.shown?.text ?? "", /^kiln-recovery:v1:/u)
        assert.include(
          first.shown?.file.content ?? "",
          "KILN_PLATFORM_BACKUP_KEY=platform-backup-key"
        )

        // Never again without a second factor, which this account lacks.
        const again = yield* reveal(null)
        assert.isNull(again.shown)
        assert.include(again.refused, "two-factor")

        // With one, a missing or wrong code is refused before the Relay is
        // asked; a right one shows it.
        people.current = administrator(true)
        const reads = relay.reads
        assert.isNull((yield* reveal(null)).shown)
        assert.isNull((yield* reveal("654321")).shown)
        assert.strictEqual(relay.reads, reads)
        assert.strictEqual((yield* reveal("123456")).shown?.kind, "key")

        // A backup code works once.
        assert.strictEqual((yield* reveal("abcde-fghij")).shown?.kind, "key")
        assert.isNull((yield* reveal("abcde-fghij")).shown)

        // Saying it's saved doesn't open it up again.
        yield* Effect.promise(() => acknowledgeRecoveryKit())
        assert.isNull((yield* reveal(null)).shown)
      })
    )

    it.effect("stops checking codes after too many wrong ones", () =>
      Effect.gen(function* () {
        yield* seed
        yield* reveal(null)
        people.current = administrator(true)
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
