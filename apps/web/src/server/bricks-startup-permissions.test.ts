import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import {
  builtinTailscaleBrick,
  relayInstanceSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { getInstanceStartupHandler } from "@/server/bricks.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows } from "@/test/seed"

// The Relay is the only network boundary: it reports its node and servers and
// serves the server's Brick recipe.
const relay = vi.hoisted(() => ({ snapshot: undefined as unknown }))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation === "relay.snapshot") return relay.snapshot
    if (operation === "brick.recipe") return builtinTailscaleBrick
    throw new Error(`Unexpected Relay operation ${operation}`)
  },
}))

afterAll(() => disposeAppRuntime())

const at = Date.UTC(2026, 0, 1)
const relayId = "r".repeat(43)
const otherRelayId = "s".repeat(43)

const member: AuthenticatedUser = {
  email: "member@example.test",
  emailVerified: true,
  emailVerifiedAt: new Date(at).toISOString(),
  id: "member",
  isDevelopmentBypass: false,
  name: "Member",
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
}

const instance = relayInstanceSchema.parse({
  id: "a".repeat(40),
  shortId: "aaaaaaaa",
  name: "Own server",
  service: "server",
  directory: "/data/server",
  containerId: "container",
  desiredState: "stopped",
  observedState: "stopped",
  status: "stopped",
  game: "Minecraft",
  implementation: "paper",
  javaVersion: "21",
  version: "1.21",
  connectAddress: "play.example.test:25565",
  brickSource: builtinTailscaleBrick.source,
  variables: {},
  limits: { diskBytes: 1024 ** 3, memoryBytes: 1024 ** 3 },
})

relay.snapshot = relaySnapshotSchema.parse({
  instances: [
    instance,
    {
      ...instance,
      id: "b".repeat(40),
      limits: { diskBytes: 2 * 1024 ** 3, memoryBytes: 2 * 1024 ** 3 },
    },
  ],
  node: {
    id: relayId,
    name: "Relay",
    version: "test",
    platform: "linux",
    arch: "arm64",
    connectedAt: new Date(at).toISOString(),
    cpu: { cores: 4, loadPercent: 0 },
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 3 * 1024 ** 3 },
    storage: { totalBytes: 20 * 1024 ** 3, usedBytes: 4 * 1024 ** 3 },
    docker: { available: true, version: "test" },
  },
})

const grant = (
  target: { relayId: string; resourceType: "relay" | "instance" },
  permissions: ReadonlyArray<AccessPermission>
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      userId: member.id,
      relayId: target.relayId,
      resourceType: target.resourceType,
      resourceId:
        target.resourceType === "relay" ? target.relayId : instance.id,
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

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  yield* insertRelay(otherRelayId)
})

const startup = (user: AuthenticatedUser) =>
  Effect.promise(() =>
    getInstanceStartupHandler(user, { relayId, instanceId: instance.id })
  )

describeMysql("startup host allocation", () => {
  layer(TestDatabase)((it) => {
    // Any Relay-wide grant implies relay.read, so only a server grant can
    // read startup settings without it.
    it.effect("withholds host allocation from a server-only grant", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant({ relayId, resourceType: "instance" }, [
          "instance.configuration.read",
        ])

        const result = yield* startup(member)

        assert.isNull(result.allocation)
        assert.deepStrictEqual(result.instance.limits, instance.limits)
        assert.strictEqual(result.brick.source, builtinTailscaleBrick.source)
      })
    )

    it.effect("does not reuse relay.read from another Relay", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant({ relayId, resourceType: "instance" }, [
          "instance.configuration.read",
        ])
        yield* grant({ relayId: otherRelayId, resourceType: "relay" }, [
          "relay.read",
        ])

        assert.isNull((yield* startup(member)).allocation)
      })
    )

    it.effect.each([
      { name: "a relay.read grant", admin: false },
      { name: "an administrator", admin: true },
    ])("shows host allocation to $name", ({ admin }) =>
      Effect.gen(function* () {
        yield* seed
        if (!admin) {
          yield* grant({ relayId, resourceType: "relay" }, [
            "relay.read",
            "instance.configuration.read",
          ])
        }

        const result = yield* startup(
          admin ? { ...member, role: "admin" } : member
        )

        assert.deepStrictEqual(result.allocation?.memory, {
          availableBytes: 6 * 1024 ** 3,
          nodeTotalBytes: 8 * 1024 ** 3,
          nodeUsedBytes: 3 * 1024 ** 3,
        })
        assert.strictEqual(
          result.allocation?.storage.nodeTotalBytes,
          20 * 1024 ** 3
        )
      })
    )
  })
})
