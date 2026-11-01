import { generateKeyPairSync, randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import {
  builtinTailscaleBrick,
  builtinTailscaleBrickSource,
  relayPeerTransfersV1Feature,
} from "@workspace/contracts"
import { Deferred, Effect, Exit, Fiber, Layer, Ref, Scope } from "effect"
import { SqlClient } from "effect/sql"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { AppCache } from "@/effect/cache"
import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { encryptPrivateKey } from "@/lib/relay-registry"
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
// what the old one packed and the new one pulled for a copy, and requests
// held as they arrive. Each test runs Hearth's engine, on the test clock,
// one Hearth after another for a restart.
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

// Hearth signs each pull's grant with the key it's paired to the old Relay
// under.
vi.stubEnv("BETTER_AUTH_SECRETS", `1:${"x".repeat(32)}`)
const oldRelayKey = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString()

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
  // What the old Relay packed, by transfer: packed once it's looked at.
  artifacts: new Map<string, "packing" | "ready">(),
  // Pulls that keep pulling until released.
  copyHeld: false,
  // The next request of each operation, answered once released.
  held: new Map<string, ReturnType<typeof hold>>(),
  journal: new Map<string, unknown>(),
  // New servers by name that stay provisioning until released.
  provisioningHeld: new Set<string>(),
  // What the new Relay pulled, by transfer.
  pulls: new Map<string, "pulling" | "cancelled">(),
  servers: new Map<string, FakeServer>(),
}

const serverKey = (relayId: string, id: string) => `${relayId}/${id}`

function resetRelay() {
  relay.artifacts.clear()
  relay.copyHeld = false
  relay.held.clear()
  relay.journal.clear()
  relay.provisioningHeld.clear()
  relay.pulls.clear()
  relay.servers.clear()
}

function hold(operation: string) {
  const held = {
    reached: Deferred.makeUnsafe<void>(),
    release: Deferred.makeUnsafe<void>(),
  }
  relay.held.set(operation, held)
  return held
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

// Answered once acted on, after the request is released if it's held.
async function fakeRelayRpc(
  relayId: string,
  operation: string,
  payload: Record<string, unknown>,
  frame: { operationId?: string }
): Promise<unknown> {
  const result = answer(relayId, operation, payload, frame)
  const held = relay.held.get(operation)
  if (held) {
    relay.held.delete(operation)
    Deferred.doneUnsafe(held.reached, Exit.void)
    await Effect.runPromise(Deferred.await(held.release))
  }
  return result
}

function answer(
  relayId: string,
  operation: string,
  payload: Record<string, unknown>,
  frame: { operationId?: string }
): unknown {
  const id = String(payload.instanceId ?? payload.id ?? payload.rootId ?? "")
  const transferId = String(payload.transferId)
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
      const state = relay.pulls.get(transferId)
      if (!state) return null
      return {
        createdAt: at,
        endpoint: null,
        error: null,
        receivedBytes: 10,
        size: 100,
        state: state === "pulling" && !relay.copyHeld ? "completed" : state,
        target: { path: "", rootId: id },
        transferId,
        updatedAt: at,
      }
    }
    case "transfer.source.get": {
      const state = relay.artifacts.get(transferId)
      if (!state) return null
      relay.artifacts.set(transferId, "ready")
      return {
        createdAt: at,
        entries: state === "ready" ? 1 : null,
        error: null,
        expiresAt: at,
        rootId: id,
        sha256: state === "ready" ? "a".repeat(64) : null,
        size: state === "ready" ? 100 : null,
        state,
        transferId,
      }
    }
  }
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
      if (!relay.artifacts.has(transferId)) {
        relay.artifacts.set(transferId, "packing")
      }
      break
    case "transfer.pull.start":
      // Only what the old Relay packed, under a grant Hearth signed.
      if (relay.artifacts.get(transferId) !== "ready" || !payload.grant) {
        throw new Error("Nothing is packed for this grant")
      }
      if (!relay.pulls.has(transferId)) relay.pulls.set(transferId, "pulling")
      // Its record is read on the next look.
      result = null
      break
    case "transfer.pull.cancel":
      relay.pulls.set(transferId, "cancelled")
      break
    case "transfer.source.discard":
      relay.artifacts.delete(transferId)
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
  }).pipe(driven)
  return { service, startHearth }
})

const disabledCache = Layer.succeed(AppCache)({
  backend: "disabled",
  enabled: false,
  get: () => Effect.succeed(undefined),
  remove: () => Effect.void,
  set: () => Effect.void,
})

// Moves the test clock on a little each time MySQL answers, so the steps'
// waits and the engine's own run about as they would beside the database,
// until `read` finds what it waits for.
const until = <A, E, R>(
  read: Effect.Effect<A, E, R>,
  done: (value: A) => boolean
) =>
  Effect.gen(function* () {
    const database = yield* Database
    for (let elapsed = 0; elapsed < 10 * 60_000; elapsed += 2) {
      const value = yield* read
      if (done(value)) return value
      yield* database.queryRows("test.tick", "SELECT 1")
      yield* TestClock.adjust("2 millis")
    }
    return yield* Effect.die("It never came")
  })

const reached = (held: ReturnType<typeof hold>) =>
  until(Deferred.isDone(held.reached), Boolean)

// Runs `effect` as the test clock moves on beside it.
const driven = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* Effect.forkChild(effect)
    yield* until(
      Effect.sync(() => fiber.pollUnsafe()),
      (exit) => exit !== undefined
    )
    return yield* Fiber.join(fiber)
  })

// Closed in full, so the next Hearth takes over the engine's shards at once:
// a step waiting in a window is cut off after the engine's grace.
const stopHearth = (scope: Scope.Closeable) =>
  driven(Scope.close(scope, Exit.void))

const operationsEnded = until(
  selectRows<{ state: string }>("operation"),
  (rows) =>
    rows.every((row) =>
      ["cancelled", "failed", "interrupted", "succeeded"].includes(row.state)
    )
)

// A fresh database with the mover, both Relays, and two game servers on the
// old Relay, both running.
const seed = Effect.gen(function* () {
  yield* resetDatabase
  resetRelay()
  yield* insertUser(mover.id, {
    emailVerifiedAt: new Date(at),
    role: "admin",
  })
  yield* insertRelay(oldRelay, {
    client_private_key_ciphertext: encryptPrivateKey(oldRelayKey),
    name: "Old",
  })
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
  }).pipe(Effect.provideService(OperationsEngineService, service), driven)
}

interface MigrationRecord {
  destination_instance_id: string
  error: string | null
  id: string
  state: string
  step: string
}

const migrations = selectRows<MigrationRecord>("server_migration")

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

// A copy's backup first is named after it.
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
        }),
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
        }),
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
          yield* until(
            selectRows<{ id: string }>("backup"),
            (rows) => rows.length === 1
          )
          yield* restart
          yield* finishBackup(id)
          // And once the old Relay packed the files, as the new one is asked
          // to pull them, before it answers.
          const pull = hold("transfer.pull.start")
          yield* reached(pull)
          yield* restart
          yield* Deferred.succeed(pull.release, undefined)
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
          // Pulled once, and what was packed for it deleted.
          assert.deepStrictEqual([...relay.pulls.values()], ["pulling"])
          assert.deepStrictEqual([...relay.artifacts], [])
          assert.strictEqual(serverState(oldRelay, survival), "stopped")
        }),
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

          yield* stopHearth(hearth)

          assert.strictEqual(earlyRow.state, "cancelled")
          assert.deepStrictEqual(serversOn(newRelay), [])
          assert.strictEqual(serverState(oldRelay, survival), "running")
        }),
      180_000
    )

    it.effect(
      "hands a finished move's old server to deletion, unless a cancel came first, and lets any other handover be cancelled",
      () =>
        Effect.gen(function* () {
          const { service, startHearth } = yield* hearths
          yield* seed
          const hearth = yield* startHearth
          const deleting = { deleteSource: {} }

          // Cancelled just before its files finish copying, the old server
          // stopped for it: it ends cancelled, never handing the old server
          // over, and what it packed and pulled is deleted.
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

          // Left to finish, it can't be cancelled while it hands over, and
          // asks for the old server's final backup and deletion last, which
          // runs once the move ends.
          const handingOver = hold("instance.network.routes.read")
          const moved = yield* start(service, {
            chosen: { ...deleting, moveWebRoutes: true },
            mode: "migrate",
            name: "Moved",
          })
          yield* reached(handingOver)
          const refused = yield* cancelServerMigrationEffect(
            mover.id,
            moved
          ).pipe(Effect.flip)
          const whileRefused = yield* migrationUntil(moved, () => true)
          yield* Deferred.succeed(handingOver.release, undefined)
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

          // A move that keeps its old server is cancelled as it hands over:
          // it keeps the new server, and starts the old one again.
          const keepingSource = hold("instance.network.routes.read")
          const kept = yield* start(service, {
            chosen: { moveWebRoutes: true },
            mode: "migrate",
            name: "Kept",
            source: creative,
          })
          yield* reached(keepingSource)
          yield* cancelServerMigrationEffect(mover.id, kept)
          yield* Deferred.succeed(keepingSource.release, undefined)
          const keptRow = yield* migrationUntil(kept, ended)
          yield* operationsEnded
          yield* stopHearth(hearth)

          assert.strictEqual(cancelledRow.state, "cancelled")
          assert.isFalse(handedEarly)
          assert.strictEqual(runningAfterCancel, "running")
          assert.include([...relay.pulls.values()], "cancelled")
          assert.match(refused.message, /can't be cancelled/)
          assert.strictEqual(whileRefused.state, "running")
          assert.strictEqual(movedRow.state, "completed")
          assert.strictEqual(deletion.final_backup, 1)
          assert.strictEqual(deletion.requested_by, mover.id)
          assert.strictEqual(serverState(oldRelay, survival), "gone")
          assert.strictEqual(keptRow.state, "cancelled")
          assert.sameMembers(serversOn(newRelay), [
            serverKey(newRelay, movedRow.destination_instance_id),
            serverKey(newRelay, keptRow.destination_instance_id),
          ])
          assert.strictEqual(serverState(oldRelay, creative), "running")
        }),
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
          relay.pulls.set("legacytransfer", "pulling")
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
          yield* operationsEnded
          yield* stopHearth(hearth)

          assert.strictEqual(undone.state, "failed")
          assert.match(undone.error ?? "", /Hearth was updated/)
          assert.deepStrictEqual(serversOn(newRelay), [])
          assert.strictEqual(serverState(oldRelay, survival), "running")
          assert.strictEqual(relay.pulls.get("legacytransfer"), "cancelled")
          assert.strictEqual(kept.state, "completed")
          assert.strictEqual(serverState(oldRelay, creative), "stopped")
        }),
      180_000
    )
  })
})

// A migration as a Hearth from before migrations were operations recorded
// it, with no operation.
function insertLegacy(row: {
  deleteSource?: boolean
  destination: string
  error?: string
  id: string
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
