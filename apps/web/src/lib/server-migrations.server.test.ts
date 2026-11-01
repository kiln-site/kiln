import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import {
  builtinTailscaleBrick,
  builtinTailscaleBrickSource,
  relayPeerTransfersV1Feature,
} from "@workspace/contracts"
import { Effect, Exit, Fiber, Layer, Ref, Schedule, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { AppCache } from "@/effect/cache"
import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { deleteResource, keepResource } from "@/lib/resource-deletion.server"
import type { ServerMigrationOptions } from "@/lib/server-migration-input"
import {
  cancelServerMigrationEffect,
  rollBackLegacyServerMigration,
  rollBackLegacyServerMigrationsEffect,
  serverMigration,
  startServerMigrationEffect,
} from "@/lib/server-migrations.server"
import { OperationsEngine } from "@/operations/engine"
import {
  OperationsEngineService,
  type OperationsEngineContext,
} from "@/operations/engine-service"
import { startRelayTransfer } from "@/server/relay-transfers.server"
import { stopScheduleDeliveries } from "@/server/schedule-deployment.server"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertBackup,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
  selectRows,
} from "@/test/seed"

// The Relays are the only fake (`relay` below): the game servers each has,
// what it was asked to change, and the copies between them. Each test runs
// Hearth's engine, one Hearth after another for a restart.
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set([relayPeerTransfersV1Feature]),
  relayConnectionState: () => ({ status: "authenticated" }),
  relayJournal: async () => ({
    clientId: "hearth-one",
    journalId: "journal-one",
  }),
  relayRpc: (
    relay: { id: string },
    operation: string,
    payload: Record<string, unknown>,
    _timeout?: number,
    _subject?: string,
    _signal?: AbortSignal,
    frame: { operationId?: string } = {}
  ) => fakeRelayRpc(relay.id, operation, payload, frame),
}))
vi.mock("@/lib/authorization-delivery", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authorization-delivery")>()),
  wakeAuthorizationDelivery: () => undefined,
}))

afterAll(async () => {
  await stopScheduleDeliveries()
  await disposeAppRuntime()
})

const at = 1_767_225_600_000
const oldRelay = "o".repeat(43)
const newRelay = "n".repeat(43)
const survival = "a1".repeat(20)
const creative = "c3".repeat(20)

const mover = {
  email: "mover@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "mover",
  isDevelopmentBypass: false,
  name: "Mover",
  role: "admin",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser

// ------------------------------------------------------------ the Relays

interface FakeServer {
  name: string
  // Created, and not yet provisioned.
  provisioning: boolean
  state: "running" | "stopped"
}

const relay = {
  // What each was asked to change, as `<relay> <operation> <id>`.
  changes: [] as Array<string>,
  journal: new Map<string, unknown>(),
  // New servers by name that stay provisioning until released.
  provisioningHeld: new Set<string>(),
  // Copies that keep pulling until released.
  copyHeld: false,
  servers: new Map<string, FakeServer>(),
  transfers: new Map<string, "pulling" | "cancelled" | "discarded">(),
}

const serverKey = (relayId: string, id: string) => `${relayId}/${id}`

function resetRelay() {
  relay.changes.length = 0
  relay.journal.clear()
  relay.provisioningHeld.clear()
  relay.copyHeld = false
  relay.servers.clear()
  relay.transfers.clear()
}

function releaseProvisioning(name: string) {
  relay.provisioningHeld.delete(name)
  for (const server of relay.servers.values()) {
    if (server.name === name) server.provisioning = false
  }
}

const serversOn = (relayId: string) =>
  [...relay.servers.keys()].filter((key) => key.startsWith(`${relayId}/`))

function instanceOf(relayId: string, id: string) {
  const server = relay.servers.get(serverKey(relayId, id))
  if (!server) return null
  return {
    brickSource: builtinTailscaleBrickSource,
    connectAddress: "play.example.test:25565",
    containerId: null,
    desiredState: server.state,
    directory: `/data/${id}`,
    game: "Minecraft",
    id,
    implementation: "paper",
    javaVersion: "21",
    limits: { cpuMillis: null, diskBytes: 1024 ** 3, memoryBytes: null },
    name: server.name,
    observedState: server.state,
    service: "survival",
    shortId: id.slice(0, 8),
    status: server.state,
    variables: {},
    version: "1.21",
    ...(server.provisioning
      ? { provisioning: { attempt: 1, error: null, phase: "queued" } }
      : {}),
  }
}

async function fakeRelayRpc(
  relayId: string,
  operation: string,
  payload: Record<string, unknown>,
  frame: { operationId?: string }
): Promise<unknown> {
  const id = String(payload.instanceId ?? payload.id ?? payload.rootId ?? "")
  switch (operation) {
    case "operation.get":
      return (
        relay.journal.get(String(payload.operationId)) ?? { status: "unknown" }
      )
    case "relay.snapshot":
      return {
        instances: serversOn(relayId).map((key) =>
          instanceOf(relayId, key.split("/")[1]!)
        ),
        node: {
          arch: "arm64",
          connectedAt: "2026-01-01T00:00:00.000Z",
          cpu: { cores: 8, loadPercent: 0 },
          docker: { available: true, version: "test" },
          id: relayId,
          memory: { totalBytes: 64 * 1024 ** 3, usedBytes: 0 },
          name: relayId === oldRelay ? "Old" : "New",
          platform: "linux",
          storage: { totalBytes: 1024 ** 4, usedBytes: 0 },
          version: "test",
        },
      }
    case "brick.recipe":
      return builtinTailscaleBrick
    case "relay.tailscale.stack.state":
    case "backup.task.list":
      return []
    case "backup.task.enqueue":
      // Followed by Hearth's own records here.
      throw new Error("The Relay's backup queue is busy")
    case "instance.network.routes.read":
      return {
        edgeConnected: true,
        message: "Ready",
        proxyConnected: true,
        requiresRestart: false,
        routes: [],
        status: "ready",
      }
    case "transfer.pull.get": {
      const state = relay.transfers.get(String(payload.transferId))
      if (!state) return null
      return {
        createdAt: at,
        endpoint: null,
        error: null,
        receivedBytes: 10,
        size: 100,
        state:
          state === "pulling"
            ? relay.copyHeld
              ? "pulling"
              : "completed"
            : "cancelled",
        target: { path: "", rootId: id },
        transferId: payload.transferId,
        updatedAt: at,
      }
    }
    case "transfer.source.get":
      return null
  }
  relay.changes.push(`${relayId} ${operation} ${id}`)
  const key = serverKey(relayId, id)
  let result: unknown = {}
  switch (operation) {
    case "instance.provision.prepare":
      if (!relay.servers.has(key)) {
        relay.servers.set(key, {
          name: String(payload.name),
          provisioning: true,
          state: "stopped",
        })
      }
      result = instanceOf(relayId, id)
      break
    case "instance.provision.claim": {
      const server = relay.servers.get(key)
      if (server && !relay.provisioningHeld.has(server.name)) {
        server.provisioning = false
      }
      result = instanceOf(relayId, id)
      break
    }
    case "instance.action": {
      const server = relay.servers.get(key)
      if (!server) throw new Error("Server not found")
      server.state = payload.action === "stop" ? "stopped" : "running"
      result = instanceOf(relayId, id)
      break
    }
    case "transfer.source.prepare":
      if (!relay.transfers.has(String(payload.transferId))) {
        relay.transfers.set(String(payload.transferId), "pulling")
      }
      break
    case "transfer.pull.cancel":
      relay.transfers.set(String(payload.transferId), "cancelled")
      break
    case "transfer.source.discard":
      if (relay.transfers.get(String(payload.transferId)) === "pulling") {
        relay.transfers.set(String(payload.transferId), "discarded")
      }
      break
    case "resource.freeze":
      result = { frozen: true }
      break
    case "instance.delete":
      relay.servers.delete(key)
      result = { deleted: true, instanceId: id }
      break
    default:
      throw new Error(`Unexpected Relay operation ${operation}`)
  }
  if (frame.operationId) {
    relay.journal.set(frame.operationId, { result, status: "succeeded" })
  }
  return result
}

// ------------------------------------------------------------ Hearth

// Hearths that run one after another on one database: each start builds a
// new engine, which Hearth's engine service then hands out.
const hearths = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const database = yield* Database
  const current = yield* Ref.make<OperationsEngineContext | null>(null)
  const service = OperationsEngineService.of({
    engine: Ref.get(current).pipe(
      Effect.flatMap((engine) =>
        engine ? Effect.succeed(engine) : Effect.never
      )
    ),
  })
  const startHearth = Effect.gen(function* () {
    const scope = yield* Scope.make()
    const engine = yield* Layer.buildWithScope(
      Layer.mergeAll(
        serverMigration.layer,
        rollBackLegacyServerMigration.layer,
        deleteResource.layer,
        keepResource.layer
      ).pipe(
        Layer.provideMerge(OperationsEngine),
        Layer.provide(Layer.succeed(SqlClient.SqlClient)(sql)),
        Layer.provide(Layer.succeed(Database)(database)),
        Layer.provide(disabledCache),
        Layer.provide(Layer.succeed(OperationsEngineService)(service))
      ),
      scope
    )
    yield* Ref.set(current, engine)
    return scope
  })
  return { service, startHearth }
})

const disabledCache = Layer.succeed(AppCache)({
  backend: "disabled",
  enabled: false,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
})

// Closed in full, so the next Hearth takes over the engine's shards at once:
// a step waiting in a window is cut off after the engine's grace.
const stopHearth = (scope: Scope.Closeable) =>
  Scope.close(scope, Exit.void).pipe(Effect.timeoutOption("30 seconds"))

const operationsEnded = selectRows<{ state: string }>("operation").pipe(
  Effect.repeat({
    schedule: Schedule.spaced("100 millis"),
    until: (rows) =>
      rows.every((row) =>
        ["cancelled", "failed", "interrupted", "succeeded"].includes(row.state)
      ),
  }),
  Effect.timeoutOption("30 seconds")
)

// A fresh database with the mover, both Relays, and two game servers on the
// old Relay, both running.
const seed = Effect.gen(function* () {
  yield* operationsEnded
  yield* resetDatabase
  resetRelay()
  yield* insertUser(mover.id, {
    emailVerifiedAt: new Date(at),
    role: "admin",
  })
  yield* insertRelay(oldRelay, { name: "Old" })
  yield* insertRelay(newRelay, { name: "New" })
  for (const [id, name] of [
    [survival, "Survival"],
    [creative, "Creative"],
  ] as const) {
    relay.servers.set(serverKey(oldRelay, id), {
      name,
      provisioning: false,
      state: "running",
    })
    yield* insertInstance(oldRelay, id, { owner_id: mover.id })
  }
})

const options = (
  mode: "duplicate" | "migrate",
  chosen: Partial<ServerMigrationOptions> = {}
): ServerMigrationOptions => ({
  backup: null,
  copyAccess: false,
  deleteSource: null,
  keepActivity: false,
  limits: null,
  linkBackups: false,
  moveDomain: false,
  moveWebRoutes: false,
  stopSource: mode === "migrate",
  ...chosen,
})

const start = (
  service: OperationsEngineService["Service"],
  input: {
    readonly chosen?: Partial<ServerMigrationOptions>
    readonly mode: "duplicate" | "migrate"
    readonly name: string
    readonly source?: string
  }
) => {
  const chosen = options(input.mode, input.chosen)
  return startServerMigrationEffect({
    actor: mover,
    backupStorageIds: chosen.backup ? [null] : [],
    destinationName: input.name,
    destinationRelayId: newRelay,
    mode: input.mode,
    options: chosen,
    source: {
      instanceId: input.source ?? survival,
      name: "Survival",
      relayId: oldRelay,
    },
  }).pipe(Effect.provideService(OperationsEngineService, service))
}

interface MigrationRecord {
  backup_id: string | null
  destination_instance_id: string
  error: string | null
  id: string
  state: string
  step: string
}

const migrations = selectRows<MigrationRecord>("server_migration")

const until = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean
) =>
  read.pipe(
    Effect.repeat({ schedule: Schedule.spaced("100 millis"), until: done }),
    Effect.timeout("60 seconds")
  )

const migrationUntil = (id: string, done: (row: MigrationRecord) => boolean) =>
  until(
    migrations.pipe(Effect.map((rows) => rows.find((row) => row.id === id))),
    (row) => row !== undefined && done(row)
  ).pipe(Effect.map((row) => row!))

const ended = (row: MigrationRecord) =>
  row.state !== "running" && row.state !== "cancelling"

const deletions = selectRows<{
  backup_id: string | null
  final_backup: number
  requested_by: string
  resource_id: string
  status: string
}>("resource_deletion")

const deletionUntil = (resourceId: string, statuses: Array<string>) =>
  until(
    deletions.pipe(
      Effect.map((rows) => rows.find((row) => row.resource_id === resourceId))
    ),
    (row) => row !== undefined && statuses.includes(row.status)
  ).pipe(Effect.map((row) => row!))

const finishBackup = (backupId: string) =>
  Effect.gen(function* () {
    const database = yield* Database
    yield* database.execute(
      "test.finishBackup",
      `UPDATE kiln_backup SET status = 'available' WHERE id = ?`,
      [backupId]
    )
  })

const serverState = (relayId: string, id: string) =>
  relay.servers.get(serverKey(relayId, id))?.state ?? "gone"

describeMysql("Server migrations", () => {
  layer(TestDatabase, { timeout: 180_000 })((it) => {
    it.effect(
      "copies one server once at a time, while another server copies alongside",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          yield* seed
          const hearth = yield* startHearth
          relay.provisioningHeld.add("First")
          relay.provisioningHeld.add("Second")

          const first = yield* start(service, {
            mode: "duplicate",
            name: "First",
          })
          yield* migrationUntil(first, (row) => row.step === "provision")
          // The same server again waits its turn; another starts at once.
          const second = yield* start(service, {
            mode: "duplicate",
            name: "Second",
          }).pipe(Effect.forkChild)
          const other = yield* start(service, {
            mode: "duplicate",
            name: "Other",
            source: creative,
          })
          yield* migrationUntil(other, ended)
          assert.strictEqual(
            (yield* migrations).filter((row) => row.state === "running").length,
            1
          )

          releaseProvisioning("First")
          const secondId = yield* Fiber.join(second)
          releaseProvisioning("Second")
          const rows = yield* Effect.all(
            [first, secondId, other].map((id) => migrationUntil(id, ended))
          )
          yield* operationsEnded
          yield* stopHearth(hearth)

          assert.deepStrictEqual(
            rows.map((row) => row.state),
            ["completed", "completed", "completed"]
          )
          assert.strictEqual(serversOn(newRelay).length, 3)
          // A duplicate leaves the old server as it was.
          assert.strictEqual(serverState(oldRelay, survival), "running")
        }).pipe(TestClock.withLive),
      180_000
    )

    it.effect(
      "holds the old server through a move, and lets a duplicate's change",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          yield* seed
          const hearth = yield* startHearth
          // Copying Creative's files into Survival changes Survival.
          const writeIntoSurvival = Effect.promise(() =>
            startRelayTransfer(mover, {
              destination: {
                path: "incoming",
                relayId: oldRelay,
                rootId: survival,
              },
              source: { paths: [], relayId: oldRelay, rootId: creative },
            }).then(
              () => "written",
              (error: Error) => error.message
            )
          )

          relay.provisioningHeld.add("Moved")
          const move = yield* start(service, { mode: "migrate", name: "Moved" })
          yield* migrationUntil(move, (row) => row.step === "provision")
          const duringMove = yield* writeIntoSurvival
          releaseProvisioning("Moved")
          yield* migrationUntil(move, ended)
          yield* operationsEnded

          relay.servers.set(serverKey(oldRelay, survival), {
            name: "Survival",
            provisioning: false,
            state: "running",
          })
          relay.provisioningHeld.add("Copied")
          const copy = yield* start(service, {
            mode: "duplicate",
            name: "Copied",
          })
          yield* migrationUntil(copy, (row) => row.step === "provision")
          const duringCopy = yield* writeIntoSurvival
          releaseProvisioning("Copied")
          yield* migrationUntil(copy, ended)
          yield* operationsEnded
          yield* stopHearth(hearth)

          assert.match(duringMove, /Moving this game server is in progress/)
          assert.strictEqual(duringCopy, "written")
        }).pipe(TestClock.withLive),
      180_000
    )

    it.effect(
      "makes one copy and one backup across restarts, and leaves a moved server stopped",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          yield* seed
          relay.provisioningHeld.add("Moved")
          let hearth = yield* startHearth
          const restart = Effect.gen(function* () {
            yield* stopHearth(hearth)
            hearth = yield* startHearth
          })

          const id = yield* start(service, {
            chosen: { backup: { storageId: null } },
            mode: "migrate",
            name: "Moved",
          })
          // Hearth stops once the copy is created, as it provisions.
          yield* migrationUntil(id, (row) => row.step === "provision")
          yield* until(
            Effect.sync(() => serversOn(newRelay).length),
            (count) => count === 1
          )
          yield* restart
          releaseProvisioning("Moved")
          // Again once the backup first is reserved.
          const { backup_id: backupId } = yield* migrationUntil(
            id,
            (row) => row.backup_id !== null
          )
          yield* until(
            selectRows<{ id: string }>("backup"),
            (rows) => rows.length === 1
          )
          yield* restart
          yield* finishBackup(backupId!)
          // And once the old server has stopped, as its files copy.
          relay.copyHeld = true
          yield* migrationUntil(id, (row) => row.step === "copy")
          yield* restart
          relay.copyHeld = false
          const row = yield* migrationUntil(id, ended)
          yield* operationsEnded
          yield* stopHearth(hearth)

          assert.strictEqual(row.state, "completed")
          assert.strictEqual(serversOn(newRelay).length, 1)
          assert.strictEqual(
            (yield* selectRows<{ relay_id: string }>("instance")).filter(
              (instance) => instance.relay_id === newRelay
            ).length,
            1
          )
          assert.strictEqual((yield* selectRows("backup")).length, 1)
          assert.strictEqual(serverState(oldRelay, survival), "stopped")
        }).pipe(TestClock.withLive),
      180_000
    )

    it.effect(
      "removes a cancelled copy and starts its old server again",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          yield* seed
          const hearth = yield* startHearth

          // Cancelled while the copy provisions: the old server never stopped.
          relay.provisioningHeld.add("Early")
          const early = yield* start(service, {
            mode: "migrate",
            name: "Early",
          })
          const { destination_instance_id: earlyCopy } = yield* migrationUntil(
            early,
            (row) => row.step === "provision"
          )
          yield* until(
            Effect.sync(() => serversOn(newRelay).length),
            (count) => count === 1
          )
          yield* cancelServerMigrationEffect(mover.id, early)
          const earlyRow = yield* migrationUntil(early, ended)
          yield* deletionUntil(earlyCopy, ["completed"])
          yield* operationsEnded

          // Cancelled while its files copy, the old server stopped for it.
          relay.copyHeld = true
          const late = yield* start(service, {
            mode: "migrate",
            name: "Late",
          })
          const { destination_instance_id: lateCopy } = yield* migrationUntil(
            late,
            (row) => row.step === "copy"
          )
          yield* until(
            Effect.sync(() => serverState(oldRelay, survival)),
            (state) => state === "stopped"
          )
          yield* cancelServerMigrationEffect(mover.id, late)
          const lateRow = yield* migrationUntil(late, ended)
          yield* deletionUntil(lateCopy, ["completed"])
          yield* operationsEnded
          yield* stopHearth(hearth)

          assert.strictEqual(earlyRow.state, "cancelled")
          assert.strictEqual(lateRow.state, "cancelled")
          assert.deepStrictEqual(serversOn(newRelay), [])
          assert.strictEqual(serverState(oldRelay, survival), "running")
          // What the copy packed or fetched is gone.
          assert.include([...relay.transfers.values()], "cancelled")
        }).pipe(TestClock.withLive),
      180_000
    )

    it.effect(
      "hands a finished move's old server to deletion, unless a cancel came first",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          yield* seed
          const hearth = yield* startHearth
          const deleting = { deleteSource: {} }

          // Cancelled just before its files finish copying: it ends
          // cancelled, never handing the old server over.
          relay.copyHeld = true
          const cancelled = yield* start(service, {
            chosen: deleting,
            mode: "migrate",
            name: "Cancelled",
          })
          const { destination_instance_id: removed } = yield* migrationUntil(
            cancelled,
            (row) => row.step === "copy"
          )
          yield* cancelServerMigrationEffect(mover.id, cancelled)
          relay.copyHeld = false
          const cancelledRow = yield* migrationUntil(cancelled, ended)
          yield* deletionUntil(removed, ["completed"])
          yield* operationsEnded
          const handedEarly = (yield* deletions).some(
            (deletion) => deletion.resource_id === survival
          )
          const runningAfterCancel = serverState(oldRelay, survival)

          // Left to finish, it asks for the old server's final backup and
          // deletion last, which runs once the move ends.
          const moved = yield* start(service, {
            chosen: deleting,
            mode: "migrate",
            name: "Moved",
          })
          const { destination_instance_id: copy } = yield* migrationUntil(
            moved,
            (row) => row.step === "finish"
          )
          const refused = yield* cancelServerMigrationEffect(
            mover.id,
            moved
          ).pipe(Effect.flip)
          const movedRow = yield* migrationUntil(moved, ended)
          const { backup_id: finalBackup } = yield* until(
            deletions.pipe(
              Effect.map((rows) =>
                rows.find((deletion) => deletion.resource_id === survival)
              )
            ),
            (deletion) => deletion?.backup_id != null
          ).pipe(Effect.map((deletion) => deletion!))
          yield* finishBackup(finalBackup!)
          const deletion = yield* deletionUntil(survival, ["completed"])
          yield* operationsEnded
          yield* stopHearth(hearth)

          assert.strictEqual(cancelledRow.state, "cancelled")
          assert.isFalse(handedEarly)
          assert.strictEqual(runningAfterCancel, "running")
          assert.strictEqual(movedRow.state, "completed")
          assert.match(refused.message, /can't be cancelled|no longer running/)
          assert.strictEqual(deletion.final_backup, 1)
          assert.strictEqual(deletion.requested_by, mover.id)
          assert.deepStrictEqual(serversOn(newRelay), [
            serverKey(newRelay, copy),
          ])
          assert.strictEqual(serverState(oldRelay, survival), "gone")
        }).pipe(TestClock.withLive),
      180_000
    )

    it.effect(
      "undoes migrations a Hearth from before left running, keeping a move already handed to deletion",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          yield* seed
          // A move copying its files, its old server stopped for it, and
          // its copy made.
          const copying = randomUUID()
          const copy = "b2".repeat(20)
          relay.servers.set(serverKey(oldRelay, survival), {
            name: "Survival",
            provisioning: false,
            state: "stopped",
          })
          relay.servers.set(serverKey(newRelay, copy), {
            name: "Copy",
            provisioning: false,
            state: "stopped",
          })
          relay.transfers.set("legacytransfer", "pulling")
          yield* insertInstance(newRelay, copy, { owner_id: mover.id })
          yield* insertLegacy({
            destination: copy,
            id: copying,
            source: survival,
            step: "copy",
            transfer: "legacytransfer",
          })
          // A move whose old server's deletion it already asked for.
          const handedOver = randomUUID()
          yield* insertLegacy({
            deleteSource: true,
            destination: "d4".repeat(20),
            error: "Relay connection closed",
            id: handedOver,
            source: creative,
            state: "cancelling",
            step: "finish",
          })
          yield* insertBackup("final-backup", {
            reason: "final_delete",
            relay_id: oldRelay,
            status: "running",
            target_id: creative,
          })
          yield* insertRows("resource_deletion", {
            actor: JSON.stringify(mover),
            backup_id: "final-backup",
            created_at: at,
            final_backup: true,
            id: randomUUID(),
            relay_id: oldRelay,
            requested_by: mover.id,
            resource_id: creative,
            resource_kind: "instance",
            status: "backing_up",
            updated_at: at,
          })
          relay.servers.get(serverKey(oldRelay, creative))!.state = "stopped"

          const hearth = yield* startHearth
          yield* rollBackLegacyServerMigrationsEffect().pipe(
            Effect.provideService(OperationsEngineService, service)
          )
          const undone = yield* migrationUntil(copying, ended)
          const kept = yield* migrationUntil(handedOver, ended)
          yield* deletionUntil(copy, ["completed"])
          yield* stopHearth(hearth)

          assert.strictEqual(undone.state, "failed")
          assert.match(undone.error ?? "", /Hearth was updated/)
          assert.deepStrictEqual(serversOn(newRelay), [])
          assert.strictEqual(serverState(oldRelay, survival), "running")
          assert.strictEqual(relay.transfers.get("legacytransfer"), "cancelled")
          assert.strictEqual(kept.state, "completed")
          assert.strictEqual(serverState(oldRelay, creative), "stopped")
        }).pipe(TestClock.withLive),
      180_000
    )

    it.effect(
      "won't cancel a move handing over to deleting its old server",
      () =>
        Effect.gen(function* () {
          yield* seed
          const deleting = randomUUID()
          yield* insertLegacy({
            deleteSource: true,
            destination: "d4".repeat(20),
            id: deleting,
            operation: randomUUID(),
            source: survival,
            step: "finish",
          })
          const keeping = randomUUID()
          yield* insertLegacy({
            destination: "e5".repeat(20),
            id: keeping,
            operation: randomUUID(),
            source: creative,
            step: "finish",
          })

          const refused = yield* cancelServerMigrationEffect(
            mover.id,
            deleting
          ).pipe(Effect.flip)
          yield* cancelServerMigrationEffect(mover.id, keeping)

          assert.match(refused.message, /can't be cancelled/)
          const rows = yield* migrations
          assert.strictEqual(
            rows.find((row) => row.id === deleting)?.state,
            "running"
          )
          assert.strictEqual(
            rows.find((row) => row.id === keeping)?.state,
            "cancelling"
          )
        })
    )
  })
})

// A migration as a Hearth from before migrations were operations recorded
// it, with no operation; or, given one, as this Hearth does.
function insertLegacy(row: {
  deleteSource?: boolean
  destination: string
  error?: string
  id: string
  operation?: string
  source: string
  state?: "running" | "cancelling"
  step: string
  transfer?: string
}) {
  return insertRows("server_migration", {
    actor: JSON.stringify(mover),
    create_key: randomUUID(),
    created_at: at,
    destination_instance_id: row.destination,
    destination_name: "Copy",
    destination_relay_id: newRelay,
    error: row.error ?? null,
    id: row.id,
    mode: "migrate",
    operation_id: row.operation ?? null,
    options: JSON.stringify(
      options("migrate", { deleteSource: row.deleteSource ? {} : null })
    ),
    requested_by: mover.id,
    source_instance_id: row.source,
    source_name: "Survival",
    source_relay_id: oldRelay,
    source_was_running: 1,
    state: row.state ?? "running",
    step: row.step,
    transfer_id: row.transfer ?? null,
    updated_at: at,
  })
}
