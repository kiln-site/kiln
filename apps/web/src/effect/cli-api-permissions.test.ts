import { Database } from "@/effect/database"
import { AppCache } from "@/effect/cache"
import { beforeEach, describe, expect, it, vi } from "vite-plus/test"
import { Effect, Layer } from "effect"
import {
  builtinTailscaleBrick,
  expandPermissionSelections,
  relayInstanceSchema,
  relaySnapshotSchema,
} from "@workspace/contracts"
import type { CliPrincipal } from "@/effect/cli-access"
import { PermissionDeniedError } from "@/effect/errors"
const f = vi.hoisted(() => {
  Object.assign(process.env, {
    DB_HOST: "127.0.0.1",
    DB_NAME: "test",
    DB_PASSWORD: "test",
    DB_USERNAME: "test",
  })
  return {
    authorize: vi.fn(),
    running: false,
    relays: vi.fn(),
    rpc: vi.fn(),
    invalidate: vi.fn(),
    storage: vi.fn(),
    reserve: vi.fn(),
    dispatch: vi.fn(),
    policy: vi.fn(),
    grants: vi.fn(),
    catalog: vi.fn(),
    reserveDatabase: vi.fn(),
    reserveRestore: vi.fn(),
    databases: vi.fn(),
  }
})
vi.mock("@/lib/access-control", async (original) => ({
  ...(await original<typeof import("@/lib/access-control")>()),
  requireRelayPermissionEffect: f.authorize,
  listUserGrantsEffect: f.grants,
}))
vi.mock("@/lib/relay-registry", async (original) => ({
  ...(await original<typeof import("@/lib/relay-registry")>()),
  listPersistedRelaysEffect: f.relays,
}))
vi.mock("@/lib/relay-connection", () => ({ relayRpc: f.rpc }))
vi.mock("@/lib/relay-client", async (original) => ({
  ...(await original<typeof import("@/lib/relay-client")>()),
  invalidateRelayCache: f.invalidate,
}))
vi.mock("@/server/domains.server", () => ({
  provisionInstanceDomainBestEffort: vi.fn().mockResolvedValue(undefined),
}))
vi.mock("@/backups/destinations/s3", async (original) => ({
  ...(await original<typeof import("@/backups/destinations/s3")>()),
  loadBackupStorageEffect: f.storage,
}))
vi.mock("@/effect/backups", async (original) => ({
  ...(await original<typeof import("@/effect/backups")>()),
  reserveInstanceBackupEffect: f.reserve,
  getBackupPolicyEffect: f.policy,
  listBackupCatalogEffect: f.catalog,
  reserveDatabaseBackupEffect: f.reserveDatabase,
  reserveBackupRestoreEffect: f.reserveRestore,
}))
vi.mock("@/effect/managed-databases", async (original) => ({
  ...(await original<typeof import("@/effect/managed-databases")>()),
  listManagedDatabaseRecordsEffect: f.databases,
}))
vi.mock("@/lib/backup-realtime.server", () => ({
  publishBackupChange: vi.fn(),
}))
vi.mock("@/lib/backup-reconciliation", () => ({
  dispatchBackupTask: f.dispatch,
}))
import {
  createCliBackupEffect,
  restoreCliBackupEffect,
  updateCliServerStartupEffect,
} from "@/effect/cli-api"
const relayId = "r".repeat(43),
  instanceId = "a".repeat(40)
const principal: CliPrincipal = {
  credentialId: "62d3fa60-eec3-4767-943d-c6ec159c5322",
  mode: "full_access",
  user: {
    id: "user",
    email: "user@example.test",
    name: "User",
    emailVerified: true,
    isDevelopmentBypass: false,
    role: "user",
    twoFactorEnabled: false,
  },
}
const recipe = {
  ...builtinTailscaleBrick,
  variables: {
    memory: {
      type: "string" as const,
      label: "Memory",
      description: "Memory",
      sensitive: false,
      required: false,
      default: "1G",
    },
    message: {
      type: "string" as const,
      label: "Message",
      description: "Message",
      sensitive: false,
      required: false,
      default: "hello",
    },
  },
  runtime: {
    ...builtinTailscaleBrick.runtime,
    resources: {
      ...builtinTailscaleBrick.runtime.resources,
      memory: "{{ variables.memory }}",
    },
  },
}
const instance = relayInstanceSchema.parse({
  id: instanceId,
  shortId: "aaaaaaaa",
  name: "Survival",
  service: "survival",
  directory: "/data/survival",
  containerId: "container",
  desiredState: "stopped",
  observedState: "stopped",
  status: "stopped",
  game: "Minecraft",
  implementation: "paper",
  javaVersion: "21",
  version: "1.21",
  connectAddress: "play.example.test:25565",
  brickSource: recipe.source,
  variables: { memory: "2G" },
  limits: { diskBytes: 1073741824, memoryBytes: 2048 },
})
const snapshot = relaySnapshotSchema.parse({
  instances: [instance],
  node: {
    id: relayId,
    name: "Relay",
    version: "test",
    platform: "linux",
    arch: "arm64",
    connectedAt: "2026-01-01T00:00:00.000Z",
    cpu: { cores: 4, loadPercent: 0 },
    memory: { totalBytes: 1, usedBytes: 0 },
    storage: { totalBytes: 1, usedBytes: 0 },
    docker: { available: true, version: "test" },
  },
})
let allowed: Set<string>
beforeEach(() => {
  vi.clearAllMocks()
  allowed = new Set()
  f.running = false
  f.authorize.mockImplementation(({ permission }) =>
    expandPermissionSelections(
      [...allowed].map((key) => ({ kind: "permission", key })),
      "instance"
    ).includes(permission)
      ? Effect.void
      : Effect.fail(
          PermissionDeniedError.make({ message: `Missing ${permission}` })
        )
  )
  f.relays.mockReturnValue(Effect.succeed([{ id: relayId, enabled: true }]))
  f.rpc.mockImplementation(async (_relay, operation, payload) =>
    operation === "relay.snapshot"
      ? {
          ...snapshot,
          instances: [
            f.running
              ? {
                  ...instance,
                  desiredState: "running",
                  observedState: "running",
                }
              : instance,
          ],
        }
      : operation === "brick.recipe"
        ? recipe
        : {
            ...instance,
            limits: {
              ...instance.limits,
              diskBytes: payload.diskLimitBytes ?? 1073741824,
            },
          }
  )
  f.invalidate.mockReturnValue(Effect.void)
  f.storage.mockReturnValue(
    Effect.succeed({ enabled: true, deleting: false, ownerUserId: "user" })
  )
  f.reserve.mockReturnValue(
    Effect.succeed({ backupId: "test", taskId: "test" })
  )
  f.reserveDatabase.mockReturnValue(
    Effect.succeed({ backupId: "safety", taskId: "safety-task" })
  )
  f.reserveRestore.mockReturnValue(Effect.succeed({ taskId: "restore-task" }))
  f.grants.mockReturnValue(Effect.succeed([]))
  f.catalog.mockReturnValue(Effect.succeed([]))
  f.databases.mockReturnValue(Effect.succeed([]))
  f.dispatch.mockResolvedValue(undefined)
  f.policy.mockReturnValue(Effect.succeed({ storageId: null }))
})
const unexpectedIO = () =>
  Effect.die(new Error("Unexpected unmocked service call"))
const testServices = Layer.mergeAll(
  Layer.succeed(Database)({
    execute: unexpectedIO,
    queryRows: unexpectedIO,
    transaction: unexpectedIO,
  }),
  Layer.succeed(AppCache)({
    backend: "disabled",
    enabled: false,
    get: unexpectedIO,
    set: unexpectedIO,
    remove: unexpectedIO,
  })
)
const run = <A, E>(effect: Effect.Effect<A, E, Database | AppCache>) =>
  Effect.runPromise(effect.pipe(Effect.provide(testServices)))
const startup = (extra: Record<string, unknown>, mode = principal.mode) =>
  run(
    updateCliServerStartupEffect(
      { ...principal, mode },
      { relayId, instanceId, start: false, ...extra }
    )
  )
const writes = () =>
  f.rpc.mock.calls.filter((call) => call[1] === "instance.startup.write")
describe("CLI startup permission boundary", () => {
  it("allows limits-only updates without configuration write", async () => {
    allowed.add("instance.limits.write")
    const result = await startup({ diskLimitBytes: 4294967296 })
    expect(result.server.diskLimitBytes).toBe(4294967296)
    expect(f.authorize.mock.calls.map(([input]) => input.permission)).toEqual([
      "instance.limits.write",
    ])
    expect(writes()[0]?.[2]).toMatchObject({
      diskLimitBytes: 4294967296,
      start: false,
      variables: instance.variables,
    })
  })
  it.each([
    { variables: { message: "new" } },
    { brick: "https://example.test/brick.yml" },
  ])(
    "rejects configuration changes with only limits authority: %j",
    async (extra) => {
      allowed.add("instance.limits.write")
      await expect(
        startup({ diskLimitBytes: 4294967296, ...extra })
      ).rejects.toMatchObject({ code: "forbidden" })
      expect(writes()).toHaveLength(0)
    }
  )
  it("requires limits for mixed updates even when the submitted limit is unchanged", async () => {
    allowed.add("instance.configuration.write")
    await expect(
      startup({ diskLimitBytes: 1073741824, variables: { message: "new" } })
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(writes()).toHaveLength(0)
    allowed.add("instance.limits.write")
    await startup({ diskLimitBytes: 4294967296, variables: { message: "new" } })
    expect(writes()).toHaveLength(1)
  })
  it("allows configuration-only updates without limits authority", async () => {
    allowed.add("instance.configuration.write")
    await startup({ variables: { message: "new" } })
    expect(writes()[0]?.[2].variables).toEqual({ memory: "2G", message: "new" })
    expect(f.authorize.mock.calls.map(([input]) => input.permission)).toEqual([
      "instance.configuration.read",
      "instance.configuration.write",
    ])
  })
  it("requires power permission when requesting start", async () => {
    allowed.add("instance.limits.write")
    await expect(
      startup({ diskLimitBytes: 4294967296, start: true })
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(writes()).toHaveLength(0)
    allowed.add("instance.power.start")
    await startup({ diskLimitBytes: 4294967296, start: true })
    expect(writes()).toHaveLength(1)
  })
  it("preserves read-only CLI credentials", async () => {
    allowed.add("instance.limits.write")
    await expect(
      startup({ diskLimitBytes: 4294967296 }, "read_only")
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(f.relays).not.toHaveBeenCalled()
  })
})
describe("CLI startup resource and power parity", () => {
  it("denies memory resource changes with configuration permission alone", async () => {
    allowed.add("instance.configuration.write")
    await expect(
      startup({ variables: { memory: "4G" } })
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(writes()).toHaveLength(0)
  })

  it("allows memory-only variables with limits permission", async () => {
    allowed.add("instance.limits.write")
    await startup({ variables: { memory: "4G" } })
    expect(writes()[0]?.[2].variables.memory).toBe("4G")
    expect(
      f.authorize.mock.calls.map(([target]) => target.permission)
    ).not.toContain("instance.configuration.write")
  })

  it.each([
    { start: false, power: "instance.power.stop" },
    { start: true, power: "instance.power.restart" },
  ])(
    "requires $power for a running server startup update",
    async ({ start, power }) => {
      f.running = true
      allowed.add("instance.limits.write")
      await expect(
        startup({ diskLimitBytes: 4294967296, start })
      ).rejects.toMatchObject({ code: "forbidden" })
      expect(writes()).toHaveLength(0)
      allowed.add(power)
      await startup({ diskLimitBytes: 4294967296, start })
      expect(writes()).toHaveLength(1)
    }
  )

  it("permits unrelated configuration on a running server with restart authority", async () => {
    f.running = true
    allowed.add("instance.configuration.write")
    allowed.add("instance.power.restart")
    await startup({ variables: { message: "new" }, start: true })
    expect(writes()[0]?.[2].variables).toEqual({ memory: "2G", message: "new" })
    expect(
      f.authorize.mock.calls.map(([target]) => target.permission)
    ).not.toContain("instance.limits.write")
  })
})

describe("CLI backup export boundary", () => {
  const input = {
    relayId,
    targetId: instanceId,
    targetKind: "instance",
    storageId: "60a4d6e2-f17f-44e1-80d3-3ca75d589dc9",
    name: "Backup",
  }
  it("requires download before reserving an export to a personal bucket", async () => {
    allowed.add("backup.create")
    await expect(
      run(createCliBackupEffect(principal, input))
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(f.reserve).not.toHaveBeenCalled()
    expect(f.dispatch).not.toHaveBeenCalled()
    allowed.add("backup.download")
    await run(createCliBackupEffect(principal, input))
    expect(f.reserve).toHaveBeenCalledOnce()
  })
  it("rechecks download authority for personal policy defaults and pins the selected destination", async () => {
    allowed.add("backup.create")
    f.policy.mockReturnValue(Effect.succeed({ storageId: input.storageId }))
    const { storageId: _storageId, ...defaults } = input
    await expect(
      run(createCliBackupEffect(principal, defaults))
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(f.reserve).not.toHaveBeenCalled()
    allowed.add("backup.download")
    await run(createCliBackupEffect(principal, defaults))
    expect(f.reserve.mock.calls[0]?.[0].storageId).toBe(input.storageId)
  })
  it("preserves create-only access to platform-managed storage", async () => {
    allowed.add("backup.create")
    f.storage.mockReturnValue(
      Effect.succeed({ enabled: true, deleting: false, ownerUserId: null })
    )
    await run(createCliBackupEffect(principal, input))
    expect(f.authorize.mock.calls.map(([target]) => target.permission)).toEqual(
      ["backup.create"]
    )
    expect(f.reserve).toHaveBeenCalledOnce()
  })
})

describe.each(["instance", "database"] as const)(
  "CLI %s restore safety export",
  (targetKind) => {
    const backupId = "29e384e0-b4af-4a53-92c9-452afba754ce"
    const storageId = "60a4d6e2-f17f-44e1-80d3-3ca75d589dc9"

    beforeEach(() => {
      allowed.add("backup.create")
      f.catalog.mockReturnValue(
        Effect.succeed([
          {
            id: backupId,
            name: "Backup",
            relayId,
            targetKind,
            targetId: instanceId,
            status: "available",
            artifactKind:
              targetKind === "instance" ? "archive" : "database_dump",
            backupMode: "full",
          },
        ])
      )
      f.grants.mockReturnValue(
        Effect.succeed([
          {
            id: "grant",
            relayId,
            resourceId: instanceId,
            resourceType: targetKind,
            role: "viewer",
            permissions: ["backup.restore"],
          },
        ])
      )
      f.reserve.mockReturnValue(Effect.succeed({ backupId, taskId: backupId }))
      f.reserveDatabase.mockReturnValue(
        Effect.succeed({ backupId, taskId: backupId })
      )
      f.reserveRestore.mockReturnValue(Effect.succeed({ taskId: backupId }))
      f.policy.mockReturnValue(Effect.succeed({ storageId }))
      f.databases.mockReturnValue(
        Effect.succeed([{ relayId, databaseId: instanceId }])
      )
    })

    it("denies personal default export before either reservation or dispatch", async () => {
      await expect(
        run(restoreCliBackupEffect(principal, { backupId, safetyBackup: true }))
      ).rejects.toMatchObject({ code: "forbidden" })
      expect(f.reserve).not.toHaveBeenCalled()
      expect(f.reserveDatabase).not.toHaveBeenCalled()
      expect(f.reserveRestore).not.toHaveBeenCalled()
      expect(f.dispatch).not.toHaveBeenCalled()
    })

    it("pins the permitted personal default on the safety backup", async () => {
      allowed.add("backup.download")
      await run(
        restoreCliBackupEffect(principal, { backupId, safetyBackup: true })
      )
      const reserveSafety =
        targetKind === "instance" ? f.reserve : f.reserveDatabase
      expect(reserveSafety).toHaveBeenCalledWith(
        expect.objectContaining({
          storageId,
          reason: "pre_restore",
          targetId: instanceId,
        })
      )
      expect(f.reserveRestore).toHaveBeenCalledOnce()
      expect(f.dispatch).toHaveBeenCalledOnce()
    })

    it("skips policy resolution and download checks when safety is disabled", async () => {
      allowed.clear()
      await run(
        restoreCliBackupEffect(principal, { backupId, safetyBackup: false })
      )
      expect(f.policy).not.toHaveBeenCalled()
      expect(f.storage).not.toHaveBeenCalled()
      expect(f.authorize).not.toHaveBeenCalled()
      expect(f.reserve).not.toHaveBeenCalled()
      expect(f.reserveDatabase).not.toHaveBeenCalled()
      expect(f.reserveRestore).toHaveBeenCalledOnce()
      expect(f.dispatch).toHaveBeenCalledOnce()
    })
  }
)
