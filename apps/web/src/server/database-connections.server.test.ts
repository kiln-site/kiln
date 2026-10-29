import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import type { DatabaseConnectionMember } from "@workspace/contracts"
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
vi.mock("@/lib/relay-connection", () => ({ relayRpc: relay.rpc }))
vi.mock("@/lib/realtime-source.server", () => ({
  publishRealtimeChange: () => undefined,
}))

import { writeDatabaseConnection } from "./database-connections.server"

const relayId = "r".repeat(43)
const database = "d".repeat(40)
const otherDatabase = "e".repeat(40)
const app = "a".repeat(40)
const server = "b".repeat(40)

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

// Permissions on the whole Relay, or on one database.
const grant = (
  userId: string,
  permissions: ReadonlyArray<AccessPermission>,
  scope:
    | { resourceType: "relay" }
    | { resourceId: string; resourceType: "database" } = {
    resourceType: "relay",
  }
) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: "resourceId" in scope ? scope.resourceId : relayId,
      resourceType: scope.resourceType,
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

// Permissions on one game server.
const grantServer = (
  userId: string,
  instanceId: string,
  permissions: ReadonlyArray<AccessPermission>
) =>
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

const relayDatabase = (members: ReadonlyArray<DatabaseConnectionMember>) => ({
  containerId: "container",
  createdAt: new Date(0).toISOString(),
  databaseName: "kiln_main",
  diskUsedBytes: null,
  engine: "postgres",
  hostname: `database-${database}`,
  id: database,
  image: "postgres:17",
  internalPort: 5432,
  limits: { cpuMillis: null, diskBytes: null, memoryBytes: null },
  members: members.map((member) => ({
    ...member,
    attached: true,
    hostnames: [],
    pendingHostnames: [],
    saved: true,
  })),
  name: "Main",
  observedState: "running",
  shortId: database.slice(0, 8),
  status: "Ready",
  supportsImportExport: true,
})

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId, { enabled: 1 })
  for (const id of [
    "databases-only",
    "apps-only",
    "servers-only",
    "everything",
    "one-database",
  ]) {
    yield* insertUser(id)
  }
  yield* grant("databases-only", ["database.network.write"])
  yield* grant("apps-only", ["app.manage"])
  yield* grant("servers-only", ["instance.network.write"])
  yield* grant("everything", [
    "database.network.write",
    "app.manage",
    "instance.network.write",
  ])
  yield* grant("one-database", ["database.network.write"], {
    resourceId: database,
    resourceType: "database",
  })
})

// Whether the connection went to the Relay, or the error that kept it.
const connect = (
  userId: string,
  member: DatabaseConnectionMember,
  databaseId = database
) =>
  Effect.promise(() =>
    writeDatabaseConnection(sessionUser(userId), {
      connected: true,
      databaseId,
      member,
      relayId,
    }).then(
      () => "sent",
      (error: unknown) => (error instanceof Error ? error.message : "failed")
    )
  )

const sentTo = () =>
  relay.rpc.mock.calls.flatMap((call) =>
    call[1] === "database.network.write" ? [call[2]] : []
  )

afterEach(() => relay.rpc.mockReset())

describeMysql("database connections in Hearth", () => {
  layer(TestDatabase)((it) => {
    it.effect(
      "needs the database's network permission and the member's own, refusing either alone",
      () =>
        Effect.gen(function* () {
          yield* seed
          relay.rpc.mockImplementation(async (_relay, operation) =>
            operation === "database.network.write"
              ? {
                  containerId: "container",
                  createdAt: new Date(0).toISOString(),
                  databaseName: "kiln_main",
                  diskUsedBytes: null,
                  engine: "postgres",
                  hostname: `database-${database}`,
                  id: database,
                  image: "postgres:17",
                  internalPort: 5432,
                  limits: {
                    cpuMillis: null,
                    diskBytes: null,
                    memoryBytes: null,
                  },
                  members: [],
                  name: "Main",
                  observedState: "running",
                  shortId: database.slice(0, 8),
                  status: "Ready",
                  supportsImportExport: true,
                }
              : { imported: 0 }
          )
          const toApp = { id: app, kind: "app" } as const
          const toServer = { id: server, kind: "instance" } as const
          const toDatabase = { id: otherDatabase, kind: "database" } as const
          const refused = "You do not have permission to perform this action"

          // The database's end alone.
          assert.strictEqual(yield* connect("databases-only", toApp), refused)
          assert.strictEqual(
            yield* connect("databases-only", toServer),
            refused
          )
          // The member's end alone.
          assert.strictEqual(yield* connect("apps-only", toApp), refused)
          assert.strictEqual(yield* connect("servers-only", toServer), refused)
          // One database's network, but not the other's, either way round.
          assert.strictEqual(
            yield* connect("one-database", toDatabase),
            refused
          )
          assert.strictEqual(
            yield* connect(
              "one-database",
              { id: database, kind: "database" },
              otherDatabase
            ),
            refused
          )
          assert.deepStrictEqual(sentTo(), [])

          assert.strictEqual(
            yield* connect("everything", { id: database, kind: "database" }),
            "A database can't connect to itself"
          )
          for (const member of [toApp, toServer, toDatabase]) {
            assert.strictEqual(yield* connect("everything", member), "sent")
          }
          assert.deepStrictEqual(
            sentTo().map((payload) => payload.member),
            [toApp, toServer, toDatabase]
          )
        })
    )

    it.effect("answers with only the members the person may read", () =>
      Effect.gen(function* () {
        yield* seed
        const hidden = "c".repeat(40)
        yield* insertUser("one-server")
        yield* grant("one-server", ["database.network.write"], {
          resourceId: database,
          resourceType: "database",
        })
        yield* grantServer("one-server", server, [
          "instance.network.write",
          "instance.read",
        ])
        relay.rpc.mockResolvedValue(
          relayDatabase([
            { id: server, kind: "instance" },
            { id: hidden, kind: "instance" },
            { id: app, kind: "app" },
            { id: otherDatabase, kind: "database" },
          ])
        )

        const answered = yield* Effect.promise(() =>
          writeDatabaseConnection(sessionUser("one-server"), {
            connected: true,
            databaseId: database,
            member: { id: server, kind: "instance" },
            relayId,
          })
        )

        assert.deepStrictEqual(
          answered.members.map((member) => member.id),
          [server]
        )
      })
    )
  })
})
