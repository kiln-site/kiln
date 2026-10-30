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
const f = vi.hoisted(() => ({
  features: new Set(["resource-limits-v1"]),
  authorize: vi.fn(),
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
}))
vi.mock("@/lib/access-control", async (original) => ({
  ...(await original<typeof import("@/lib/access-control")>()),
  requireRelayPermissionEffect: f.authorize,
  listUserGrantsEffect: f.grants,
}))
vi.mock("@/lib/relay-registry", async (original) => ({
  ...(await original<typeof import("@/lib/relay-registry")>()),
  listPersistedRelaysEffect: f.relays,
}))
vi.mock("@/lib/relay-connection", () => ({
  relayConnectionFeatures: () => f.features,
  relayRpc: f.rpc,
}))
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
  f.features = new Set(["resource-limits-v1"])
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
      ? snapshot
      : operation === "brick.recipe"
        ? recipe
        : {
            ...instance,
            limits: {
              ...instance.limits,
              diskBytes: payload.limits?.diskBytes ?? 1073741824,
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
  it("denies memory resource changes with configuration permission alone", async () => {
    allowed.add("instance.configuration.write")
    await expect(
      startup({ variables: { memory: "4G" } })
    ).rejects.toMatchObject({ code: "forbidden" })
    expect(writes()).toHaveLength(0)
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
    expect(f.reserve).toHaveBeenCalled()
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
})
