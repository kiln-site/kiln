import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import {
  builtinTailscaleBrick,
  relayInstanceSchema,
  relayResourceLimitsV1Feature,
  relaySnapshotSchema,
} from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { updateInstanceLimitsHandler } from "@/server/bricks.server"
import { getResourceLimitsCapacityHandler } from "@/server/resource-limits.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows } from "@/test/seed"

// The Relay is the only network boundary: it reports its node and servers and
// takes the new limits.
const relay = vi.hoisted(() => ({
  applied: [] as Array<unknown>,
  snapshot: undefined as unknown,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set([relayResourceLimitsV1Feature]),
  relayRpc: async (_relay: unknown, operation: string, payload: unknown) => {
    if (operation === "relay.snapshot") return relay.snapshot
    if (operation === "database.list") return []
    if (operation === "instance.startup.write") {
      relay.applied.push(payload)
      return instance
    }
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
  variables: { secret: "kept" },
  limits: { diskBytes: 1024 ** 3, memoryBytes: 1024 ** 3 },
})

const snapshotWith = (server: typeof instance) =>
  relaySnapshotSchema.parse({
    instances: [
      server,
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
  relay.applied = []
  relay.snapshot = snapshotWith(instance)
  yield* resetDatabase
  yield* insertRelay(relayId)
  yield* insertRelay(otherRelayId)
})

const capacity = (id = instance.id, kind: "app" | "server" = "server") =>
  Effect.promise(() =>
    getResourceLimitsCapacityHandler(member, { id, kind, relayId })
  )

const newLimits = {
  cpuMillis: 2000,
  diskBytes: 2 * 1024 ** 3,
  memoryBytes: null,
}

const saveLimits = Effect.tryPromise(() =>
  updateInstanceLimitsHandler(member, {
    instanceId: instance.id,
    limits: newLimits,
    relayId,
  })
)

describeMysql("resource limits", () => {
  layer(TestDatabase)((it) => {
    it.effect("does not reuse relay.read from another Relay", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant({ relayId, resourceType: "instance" }, ["instance.read"])
        yield* grant({ relayId: otherRelayId, resourceType: "relay" }, [
          "relay.read",
        ])

        assert.isNull(yield* capacity())
      })
    )

    it.effect("counts what every other instance on the node holds", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant({ relayId, resourceType: "relay" }, [
          "instance.read",
          "relay.read",
        ])

        const room = yield* capacity()
        assert.strictEqual(room?.cores, 4)
        assert.strictEqual(room?.assignableMemoryBytes, 6 * 1024 ** 3)
      })
    )

    it.effect("gives an app with no containers the whole node", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant({ relayId, resourceType: "relay" }, [
          "app.read",
          "relay.read",
        ])

        const room = yield* capacity("c".repeat(40), "app")
        assert.strictEqual(room?.assignableMemoryBytes, 5 * 1024 ** 3)
      })
    )

    it.effect("keeps a stopped server's Startup and leaves it stopped", () =>
      Effect.gen(function* () {
        yield* seed

        yield* saveLimits

        assert.deepInclude(relay.applied[0], {
          limits: newLimits,
          start: false,
          variables: { secret: "kept" },
        })
      })
    )

    it.effect("refuses to restart a running server without permission", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant({ relayId, resourceType: "instance" }, [
          "instance.limits.write",
        ])
        relay.snapshot = snapshotWith({
          ...instance,
          desiredState: "running",
          observedState: "running",
        })

        const refused = yield* Effect.exit(saveLimits)

        assert.isTrue(refused._tag === "Failure")
        assert.deepEqual(relay.applied, [])
      })
    )

    it.effect("restarts a running server on its new limits", () =>
      Effect.gen(function* () {
        yield* seed
        yield* grant({ relayId, resourceType: "instance" }, [
          "instance.limits.write",
          "instance.power.restart",
        ])
        relay.snapshot = snapshotWith({
          ...instance,
          desiredState: "running",
          observedState: "running",
        })

        yield* saveLimits

        assert.deepInclude(relay.applied[0], {
          limits: newLimits,
          start: true,
        })
      })
    )
  })
})
