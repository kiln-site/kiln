import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

import { requireTunnelPermission } from "./tunnel-access.server"

const relayId = "1".repeat(12)
const otherRelayId = "2".repeat(12)
const tailnetId = "a".repeat(12)
const tunnelId = "b".repeat(12)

afterAll(() => disposeAppRuntime())

const at = Date.UTC(2026, 0, 1)
const member = (id: string): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: new Date(at).toISOString(),
  id,
  isDevelopmentBypass: false,
  name: id,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
})

const grant = (
  userId: string,
  relay: string,
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId: relay,
      resourceId: relay,
      resourceType: "relay",
      userId,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
  })

const allowed = (userId: string, permission: AccessPermission) =>
  Effect.promise(() =>
    requireTunnelPermission(member(userId), tunnelId, permission).then(
      () => true,
      () => false
    )
  )

describeMysql("Who may act on a tunnel", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "is its owner, and whoever holds the permission on its Relay",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertRelay(otherRelayId)
          for (const id of ["owner", "operator", "elsewhere", "stranger"]) {
            yield* insertUser(id)
          }
          yield* insertRows("instance_group", {
            created_at: at,
            created_by: "owner",
            id: tailnetId,
            name: "Home",
            updated_at: at,
          })
          yield* insertRows("tailnet", {
            created_at: at,
            domain: "kiln",
            id: tailnetId,
            owner_id: "owner",
            updated_at: at,
          })
          yield* insertRows("tunnel", {
            cleanup_next_attempt_at: at,
            id: tunnelId,
            observed_at: at,
            owner_id: "owner",
            relay_id: relayId,
            state: "{}",
            tailnet_id: tailnetId,
            updated_at: at,
          })
          // A grant on its Relay reaches it, as it reaches everything there.
          yield* grant("operator", relayId, ["instance.terminal"])
          // One on another Relay doesn't.
          yield* grant("elsewhere", otherRelayId, ["instance.terminal"])

          assert.isTrue(yield* allowed("owner", "instance.terminal"))
          assert.isTrue(yield* allowed("owner", "instance.deploy"))
          assert.isTrue(yield* allowed("operator", "instance.terminal"))
          assert.isFalse(yield* allowed("operator", "instance.deploy"))
          assert.isFalse(yield* allowed("elsewhere", "instance.terminal"))
          assert.isFalse(yield* allowed("stranger", "instance.logs.read"))
        })
    )
  })
})
