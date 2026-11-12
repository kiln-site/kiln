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
import {
  createBackupRunHandler,
  type BackupRunInput,
} from "@/server/backup-runs.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackupStorage,
  insertGrant,
  insertRelay,
  insertRows,
  selectRows,
} from "@/test/seed"

const relayId = "1".repeat(12)
const databaseId = "d".repeat(12)
const serverId = "e".repeat(12)
const storageId = "11111111-1111-4111-8111-111111111111"
const media = "a".repeat(40)
const uploads = "b".repeat(40)
const at = Date.UTC(2026, 10, 1)

// The Relay is the only network boundary: it lists its volumes with the
// Apps that use each, and takes the backups it is sent.
const relay = vi.hoisted(() => ({
  dispatched: [] as Array<{
    batch?: { id: string; size: number }
    target: { id: string; kind: string }
  }>,
  // The game servers it has.
  snapshot: null as unknown,
}))
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string) => {
    if (operation === "relay.snapshot") return relay.snapshot
    // It takes whichever volumes a configuration says it mounts.
    if (operation === "app.volumes.write") return {}
    if (operation !== "relay.volumes.read") {
      throw new Error(`Unexpected Relay request ${operation}`)
    }
    const volume = (id: string, name: string, users: Array<string>) => ({
      createdAt: null,
      dockerName: `kiln-${id.slice(0, 8)}`,
      id,
      kind: "kiln",
      mountpoint: null,
      mounts: [],
      name,
      sizeBytes: null,
      users: users.map((appId) => ({
        appId,
        configured: true,
        mounted: false,
      })),
    })
    return {
      filesAvailable: false,
      measuring: false,
      missing: [],
      protection: { ready: true, reason: null },
      uncovered: [],
      volumes: [
        volume(media, "media", ["1".repeat(11) + "a"]),
        volume(uploads, "uploads", ["1".repeat(11) + "b"]),
      ],
    }
  },
}))
vi.mock("@/lib/relay-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-registry")>()),
  activeRelay: async () => ({ enabled: true, id: relayId, name: "Relay" }),
}))
vi.mock("@/lib/backup-reconciliation", () => ({
  dispatchBackupTask: async (
    _relay: unknown,
    input: (typeof relay.dispatched)[number]
  ) => {
    relay.dispatched.push(input)
  },
}))

// App configurations are kept encrypted.
vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)

afterAll(() => disposeAppRuntime())

relay.snapshot = relaySnapshotSchema.parse({
  instances: [
    relayInstanceSchema.parse({
      brickSource: builtinTailscaleBrick.source,
      connectAddress: "play.example.test:25565",
      containerId: "container",
      desiredState: "stopped",
      directory: "/data/server",
      game: "Minecraft",
      id: serverId,
      implementation: "paper",
      javaVersion: "21",
      limits: { diskBytes: 1024 ** 3, memoryBytes: 1024 ** 3 },
      name: "Survival",
      observedState: "stopped",
      service: "server",
      status: "stopped",
      variables: {},
      version: "1.21",
    }),
  ],
  node: {
    arch: "arm64",
    connectedAt: new Date(at).toISOString(),
    cpu: { cores: 4, loadPercent: 0 },
    docker: { available: true, version: "test" },
    id: relayId,
    memory: { totalBytes: 8 * 1024 ** 3, usedBytes: 0 },
    name: "Relay",
    platform: "linux",
    storage: { totalBytes: 20 * 1024 ** 3, usedBytes: 0 },
    version: "test",
  },
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

// Permissions on the whole Relay, where a volume's backups are granted.
const grant = (permissions: ReadonlyArray<AccessPermission>) =>
  Effect.gen(function* () {
    const id = randomUUID()
    yield* insertGrant({
      id,
      relayId,
      resourceId: relayId,
      resourceType: "relay",
      userId: user.id,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_kind: "permission",
        selection_key: permission,
      }))
    )
    return id
  })

const seed = Effect.gen(function* () {
  yield* resetDatabase
  yield* insertRelay(relayId)
  yield* insertRows("database", {
    brick_id: "mysql",
    created_at: new Date(at),
    created_by: "someone-else",
    database_id: databaseId,
    database_name: "site",
    engine: "mysql",
    internal_port: 3306,
    name: "Site data",
    password_ciphertext: "ciphertext",
    relay_id: relayId,
    updated_at: new Date(at),
    username: "site",
  })
  relay.dispatched = []
})

// Two volumes and a database, chosen together.
const chosen = (consistency: "live" | "stopped"): BackupRunInput => ({
  consistency,
  name: "Before the upgrade",
  storageIds: [null],
  targets: [
    { id: media, kind: "volume", relayId },
    { id: uploads, kind: "volume", relayId },
    { id: databaseId, kind: "database", relayId },
  ],
})

const run = (input: BackupRunInput) =>
  Effect.tryPromise({
    try: () => createBackupRunHandler(user, input),
    catch: (error) => error as Error,
  })
const backups = selectRows<{
  batch_id: string | null
  target_id: string
  target_kind: string
}>("backup")

describeMysql("Backup runs", () => {
  layer(TestDatabase)((it) => {
    // What is chosen is what is backed up: each a backup of its own, kept
    // together, and none of them when one can't be made, since a run that
    // came up short would read as everything chosen being safe.
    it.effect(
      "backs up everything chosen as one run, and nothing when one of them is refused",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* grant(["backup.create"])

          const made = yield* run(chosen("live"))

          const rows = yield* backups
          assert.sameDeepMembers(
            rows.map(({ target_id, target_kind }) => [target_kind, target_id]),
            [
              ["volume", media],
              ["volume", uploads],
              ["database", databaseId],
            ]
          )
          assert.isNotNull(made.batchId)
          assert.isTrue(rows.every((row) => row.batch_id === made.batchId))
          assert.lengthOf(relay.dispatched, 3)

          // An administrator turned backups off for one of the volumes.
          yield* insertRows("backup_policy", {
            admin_quantity_limit: 0,
            created_at: at,
            exclude_patterns: "[]",
            relay_id: relayId,
            target_id: "c".repeat(40),
            target_kind: "volume",
            updated_at: at,
          })
          const refused = yield* run({
            ...chosen("live"),
            targets: [
              { id: databaseId, kind: "database", relayId },
              { id: "c".repeat(40), kind: "volume", relayId },
            ],
          }).pipe(Effect.flip)
          assert.instanceOf(refused, Error)
          assert.lengthOf(yield* backups, 3)
          assert.lengthOf(relay.dispatched, 3)
        })
    )

    // A game server alone is incremental unless told otherwise, to the one
    // place its snapshots go. Chosen with anything else it is a full
    // archive, as the dialog says, which goes wherever the rest go: left
    // incremental, the run would be refused for its two destinations, or
    // make a snapshot nobody asked for.
    it.effect(
      "takes a game server as a full archive when it is chosen with anything else",
      () =>
        Effect.gen(function* () {
          yield* seed
          yield* insertBackupStorage(storageId)
          yield* grant(["backup.create"])

          yield* run({
            consistency: "live",
            name: "Before the upgrade",
            storageIds: [null, storageId],
            targets: [
              { id: serverId, kind: "instance", relayId },
              { id: media, kind: "volume", relayId },
            ],
          })

          const rows = yield* selectRows<{
            artifact_kind: string
            backup_mode: string
            target_kind: string
          }>("backup")
          assert.sameDeepMembers(
            rows.map(({ artifact_kind, backup_mode, target_kind }) => [
              target_kind,
              backup_mode,
              artifact_kind,
            ]),
            [
              ["instance", "full", "archive"],
              ["volume", "full", "tar_archive"],
            ]
          )
        })
    )

    it.effect(
      "takes nothing for someone who may not back up everything chosen",
      () =>
        Effect.gen(function* () {
          yield* seed
          // The database alone, not the Relay's volumes.
          const id = randomUUID()
          yield* insertGrant({
            id,
            relayId,
            resourceId: databaseId,
            resourceType: "database",
            userId: user.id,
          })
          yield* insertRows("access_selection", {
            access_id: id,
            selection_kind: "permission",
            selection_key: "backup.create",
          })

          const refused = yield* run(chosen("live")).pipe(Effect.flip)

          assert.include(refused.message, "permission to back up this volume")
          assert.lengthOf(yield* backups, 0)
        })
    )

    // Stopped, every App that uses any chosen volume stops, so it takes
    // permission to stop each; and the volumes stop them once, together,
    // which the Relay does for backups that say they are one batch.
    it.effect(
      "stops the Apps of a run's volumes once, its databases dumped meanwhile, for someone who may stop each",
      () =>
        Effect.gen(function* () {
          yield* seed
          const access = yield* grant(["backup.create"])

          const refused = yield* run(chosen("stopped")).pipe(Effect.flip)
          assert.include(refused.message, "permission to stop each")
          assert.lengthOf(yield* backups, 0)

          yield* insertRows("access_selection", {
            access_id: access,
            selection_kind: "permission",
            selection_key: "instance.power.stop",
          })
          const made = yield* run(chosen("stopped"))

          // The database is dumped within their window, with those Apps
          // stopped, so it and the volumes are taken while they write nothing.
          const window = { id: made.batchId, size: 3 }
          assert.sameDeepMembers<unknown>(
            relay.dispatched.map(({ batch, target }) => [target.id, batch]),
            [
              [media, window],
              [uploads, window],
              [databaseId, window],
            ]
          )

          // A database with no volume beside it has nothing to stop for.
          relay.dispatched = []
          yield* run({
            ...chosen("stopped"),
            targets: [{ id: databaseId, kind: "database", relayId }],
          })
          assert.deepStrictEqual(
            relay.dispatched.map(({ batch }) => batch),
            [undefined]
          )
        })
    )
  })
})
