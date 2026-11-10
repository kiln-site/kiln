import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { relayInstanceSchema, relaySnapshotSchema } from "@workspace/contracts"
import { Effect } from "effect"
import { afterAll, afterEach, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import type { AccessPermission } from "@/lib/permissions"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertGrant, insertRelay, insertRows, insertUser } from "@/test/seed"

vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
afterAll(() => disposeAppRuntime())

// The Relay control channel is the only external boundary here.
const relay = vi.hoisted(() => ({ rpc: vi.fn() }))
vi.mock("@/lib/relay-connection", () => ({
  relayConnectionFeatures: () => new Set(["connected"]),
  relayRpc: relay.rpc,
}))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

import { redeployInstanceHandler } from "./instance-deploy.server"

const relayId = "1".repeat(12)
const instanceId = "a".repeat(12)
const secret = "rcon-password-never-shown"
const source = "https://token:hunter2@bricks.example.test/private.yml"

const sessionUser = (id: string): AuthenticatedUser => ({
  email: `${id}@example.test`,
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id,
  isDevelopmentBypass: false,
  name: id,
  role: "user",
  status: "enabled",
  twoFactorEnabled: false,
})

const grant = (userId: string, permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: instanceId,
      resourceType: "instance",
      state: "active",
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

// As its Relay has it: with the answers it was started with and where its
// Brick came from, either of which can hold a credential.
const instance = relayInstanceSchema.parse({
  brickSource: source,
  connectAddress: "play.example.test:25565",
  containerId: "container",
  desiredState: "running",
  directory: "/data/survival",
  game: "Minecraft",
  id: instanceId,
  implementation: "paper",
  javaVersion: "21",
  limits: { diskBytes: 1_073_741_824, memoryBytes: 2_048 },
  name: "Survival",
  observedState: "running",
  service: "survival",
  status: "running",
  variables: { rcon_password: secret },
  version: "1.21",
})
const snapshot = relaySnapshotSchema.parse({
  instances: [instance],
  node: {
    arch: "arm64",
    connectedAt: "2026-01-01T00:00:00.000Z",
    cpu: { cores: 4, loadPercent: 0 },
    docker: { available: true, version: "test" },
    id: relayId,
    memory: { totalBytes: 1, usedBytes: 0 },
    name: "Relay",
    platform: "linux",
    storage: { totalBytes: 1, usedBytes: 0 },
    version: "test",
  },
})

const deploysAsked = () =>
  relay.rpc.mock.calls.filter(([, operation]) => operation === "instance.deploy")

describeMysql("redeploying a game server", () => {
  afterEach(() => relay.rpc.mockReset())

  layer(TestDatabase)((it) => {
    const seed = Effect.gen(function* () {
      yield* resetDatabase
      yield* insertRelay(relayId, { enabled: 1 })
      for (const id of ["deployer", "configurer"]) yield* insertUser(id)
      yield* grant("deployer", ["instance.deploy"])
      yield* grant("configurer", ["instance.configuration.write"])
      relay.rpc.mockImplementation(async (_relay, operation) => {
        if (operation === "relay.snapshot") return snapshot
        if (operation === "instance.deploy") return instance
        throw new Error(`Unexpected Relay request: ${operation}`)
      })
    })

    it.effect(
      "answers whoever may only deploy it without its startup answers or its Brick's source",
      () =>
        Effect.gen(function* () {
          yield* seed

          const answered = yield* Effect.promise(() =>
            redeployInstanceHandler(sessionUser("deployer"), {
              instanceId,
              relayId,
            })
          )

          assert.strictEqual(deploysAsked().length, 1)
          assert.strictEqual(answered.id, instanceId)
          const told = JSON.stringify(answered)
          assert.notInclude(told, secret)
          assert.notInclude(told, "hunter2")
        })
    )

    it.effect("takes the deploy permission, not what configures it", () =>
      Effect.gen(function* () {
        yield* seed

        const refused = yield* Effect.promise(() =>
          redeployInstanceHandler(sessionUser("configurer"), {
            instanceId,
            relayId,
          }).then(
            () => false,
            () => true
          )
        )

        assert.isTrue(refused)
        assert.strictEqual(deploysAsked().length, 0)
      })
    )
  })
})
