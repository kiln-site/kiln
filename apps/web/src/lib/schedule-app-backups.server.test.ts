import { layer } from "@effect/vitest"
import type { AccessPermission } from "@workspace/contracts"
import type {
  ScheduleAction,
  ScheduleTarget,
} from "@workspace/contracts/schedules"
import { randomUUID } from "node:crypto"
import { Effect } from "effect"
import { afterAll, expect, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { requireScheduleAppBackups } from "@/lib/schedule-app-backups.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows } from "@/test/seed"

// The App's Relay reports its volumes, or is away.
const relay = vi.hoisted(() => ({ online: true }))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation !== "relay.volumes.read" || !relay.online) {
      throw new Error("Relay is offline")
    }
    return {
      measuring: false,
      protection: { ready: true, reason: null },
      uncovered: [],
      volumes: [
        {
          createdAt: null,
          dockerName: "kiln-app_data",
          id: `${appId}/data`,
          kind: "app",
          mountpoint: null,
          mounts: [],
          name: "data",
          owner: { appId, volume: "data" },
          sizeBytes: null,
          users: [
            { appId, configured: true, mounted: true },
            { appId: otherAppId, configured: true, mounted: true },
          ],
        },
      ],
    }
  },
}))

afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const appId = "a".repeat(40)
const otherAppId = "b".repeat(40)
const target: ScheduleTarget = {
  id: appId,
  kind: "app",
  name: "Shop",
  relayId,
}
const backup = (consistency: "live" | "stopped"): ScheduleAction => ({
  consistency,
  destination: { kind: "local" },
  id: "5d8f43a2-6a0e-4d36-9c11-3b1f4f5e2a10",
  mode: "full",
  name: "Nightly",
  type: "backup",
})
const user: AuthenticatedUser = {
  email: "member@example.test",
  emailVerified: true,
  emailVerifiedAt: new Date(Date.UTC(2026, 0, 1)).toISOString(),
  id: "member",
  isDevelopmentBypass: false,
  name: "Member",
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}

const grantId = randomUUID()
// A permission on the whole Relay, where App permissions are granted.
const allow = (permission: AccessPermission) =>
  insertRows("access_selection", {
    access_id: grantId,
    selection_kind: "permission",
    selection_key: permission,
  })

describeMysql("scheduled App backups", () => {
  layer(TestDatabase)((it) => {
    const check = (action: ScheduleAction, existing?: ScheduleAction) =>
      Effect.promise(() =>
        requireScheduleAppBackups({
          actions: [action],
          ...(existing ? { existing: { actions: [existing] } } : {}),
          targets: [target],
          user,
        }).then(
          () => null,
          (cause: unknown) =>
            cause instanceof Error ? cause.message : String(cause)
        )
      )

    it.effect(
      "stops an App on a schedule only for someone who may manage every App it stops",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId, { enabled: true })
          yield* insertGrant({
            id: grantId,
            relayId,
            resourceId: relayId,
            resourceType: "relay",
            userId: user.id,
          })
          yield* allow("app.files.read")
          relay.online = true

          // A live backup stops nothing.
          expect(yield* check(backup("live"))).toBeNull()
          expect(yield* check(backup("stopped"))).not.toBeNull()

          yield* allow("app.manage")
          expect(yield* check(backup("stopped"))).toBeNull()

          // While its Relay can't say which Apps it would stop, only a
          // stopped backup the schedule already had is kept.
          relay.online = false
          expect(yield* check(backup("stopped"))).not.toBeNull()
          expect(yield* check(backup("stopped"), backup("stopped"))).toBeNull()
        }),
      60_000
    )
  })
})
