import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Effect } from "effect"
import { afterAll } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

import {
  requireGatewayPermission,
  requireTunnelManager,
} from "./tunnel-access.server"

const relayId = "1".repeat(12)
const otherRelayId = "2".repeat(12)
const tunnelId = "a".repeat(12)
const gatewayId = "b".repeat(12)

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

// Changing the tunnel itself, and connecting to it, is its owner's.
const manages = (userId: string) =>
  Effect.promise(() =>
    requireTunnelManager(member(userId), tunnelId).then(
      () => true,
      () => false
    )
  )

const allowed = (userId: string, permission: AccessPermission) =>
  Effect.promise(() =>
    requireGatewayPermission(member(userId), gatewayId, permission).then(
      () => true,
      () => false
    )
  )

describeMysql("Who may act on a tunnel", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "is its owner's, and whoever holds the permission on a gateway's Relay",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          yield* insertRelay(relayId)
          yield* insertRelay(otherRelayId)
          for (const id of ["owner", "operator", "elsewhere", "stranger"]) {
            yield* insertUser(id)
          }
          yield* insertRows("tunnel", {
            created_at: at,
            id: tunnelId,
            name: "Home",
            owner_id: "owner",
            updated_at: at,
          })
          yield* insertRows("tunnel_gateway", {
            cleanup_next_attempt_at: at,
            id: gatewayId,
            observed_at: at,
            owner_id: "owner",
            relay_id: relayId,
            state: "{}",
            tunnel_id: tunnelId,
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

          // A grant reaching a gateway's Relay doesn't reach the tunnel.
          assert.isTrue(yield* manages("owner"))
          assert.isFalse(yield* manages("operator"))
          assert.isFalse(yield* manages("stranger"))
        })
    )
  })
})
