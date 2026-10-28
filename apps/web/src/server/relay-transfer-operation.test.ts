import { generateKeyPairSync } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { relayPeerTransfersV1Feature } from "@workspace/contracts"
import { exclusive } from "@workspace/operations"
import { Deferred, Effect, Fiber, Layer, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { RelayUnavailableError } from "@/effect/errors"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { findOperation } from "@/operations/lanes"
import { quickOperation, runOperation } from "@/operations/run"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

import {
  cancelRelayTransferEffect,
  relayTransfer,
  startRelayTransferEffect,
} from "./relay-transfers.server"

// The Relays are the only fake: what each holds of a transfer, as their
// transfer workers keep it. Packing and a pull each move on a step when
// they're asked about, unless they're held; a pull ends failed when told
// to. The destination can be offline.
const relays = vi.hoisted(() => ({
  failPull: false,
  holdPacking: false,
  holdPull: false,
  offline: false,
  pulls: new Map<string, Record<string, unknown>>(),
  sources: new Map<string, Record<string, unknown>>(),
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set([relayPeerTransfersV1Feature]),
  relayConnectionState: () => ({
    status: relays.offline ? "unreachable" : "authenticated",
  }),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { transferId: string; rootId?: string }
  ) => {
    if (relays.offline) {
      throw RelayUnavailableError.make({ message: "The Relay is offline" })
    }
    const { transferId } = payload
    switch (operation) {
      case "transfer.source.prepare": {
        const source = relays.sources.get(transferId) ?? {
          createdAt: 0,
          entries: 3,
          error: null,
          expiresAt: Date.now() + 86_400_000,
          rootId: payload.rootId,
          sha256: "a".repeat(64),
          size: 300,
          state: "packing",
          transferId,
        }
        relays.sources.set(transferId, source)
        return source
      }
      case "transfer.source.get": {
        const source = relays.sources.get(transferId)
        if (source?.state === "packing" && !relays.holdPacking) {
          relays.sources.set(transferId, { ...source, state: "ready" })
        }
        return source ?? null
      }
      case "transfer.source.discard":
        relays.sources.delete(transferId)
        return null
      case "transfer.pull.start": {
        const pull = relays.pulls.get(transferId) ?? {
          createdAt: 0,
          endpoint: null,
          error: null,
          receivedBytes: 0,
          size: 300,
          state: "pulling",
          target: { path: "", rootId: "b".repeat(40) },
          transferId,
          updatedAt: 0,
        }
        relays.pulls.set(transferId, pull)
        return pull
      }
      case "transfer.pull.get": {
        const pull = relays.pulls.get(transferId)
        if (!pull) return null
        if (pull.state === "pulling" && !relays.holdPull) {
          relays.pulls.set(
            transferId,
            relays.failPull
              ? { ...pull, error: "The source went away", state: "failed" }
              : { ...pull, receivedBytes: 300, state: "completed" }
          )
        }
        return pull
      }
      case "transfer.pull.cancel": {
        const pull = relays.pulls.get(transferId)
        if (pull) relays.pulls.set(transferId, { ...pull, state: "cancelled" })
        return null
      }
    }
    throw new Error(`Unexpected Relay call ${operation}`)
  },
}))

// The key Hearth signs grants with, as its pairing with the source keeps.
const signingKey = vi.hoisted(() => ({ pem: "" }))
vi.mock("@/lib/relay-registry", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-registry")>()),
  loadRelayCredentials: async () => ({
    caCertificatePem: null,
    clientId: "hearth-client",
    clientPrivateKeyPem: signingKey.pem,
  }),
}))
signingKey.pem = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "pem", type: "pkcs8" })
  .toString()

afterAll(() => disposeAppRuntime())

const Transfers = testOperationsEngine(relayTransfer.layer).pipe(
  Layer.provideMerge(TestDatabase)
)

const admin: AuthenticatedUser = {
  email: "admin@example.test",
  emailVerified: true,
  emailVerifiedAt: new Date(0).toISOString(),
  id: "admin",
  isDevelopmentBypass: true,
  legacyVerificationRecordedAt: null,
  manuallyVerifiedAt: null,
  name: "Admin",
  role: "admin",
  status: "enabled",
  twoFactorEnabled: false,
}

const request = {
  destination: { path: "", relayId: "relay-two", rootId: "b".repeat(40) },
  source: { paths: [], relayId: "relay-one", rootId: "a".repeat(40) },
}

const seed = Effect.gen(function* () {
  yield* resetDatabase
  relays.failPull = false
  relays.holdPacking = false
  relays.holdPull = false
  relays.offline = false
  relays.pulls.clear()
  relays.sources.clear()
  yield* insertRelay("relay-one")
  yield* insertRelay("relay-two")
})

// Work that replaces the destination, holding it until it's let go.
const replacing = quickOperation<null>({
  kind: "test.replace",
  locks: () => [exclusive(`instance:relay-two/${"b".repeat(40)}`)],
  version: 1,
})
const holdDestination = Effect.gen(function* () {
  const release = yield* Deferred.make<void>()
  const holding = yield* Effect.forkDetach(
    runOperation(replacing, null, Deferred.await(release))
  )
  return Deferred.succeed(release, undefined).pipe(
    Effect.andThen(Fiber.join(holding))
  )
})

const operationOf = (transferId: string, done: boolean) =>
  findOperation(relayTransfer.kind, transferId).pipe(
    Effect.repeat({
      schedule: Schedule.spaced("50 millis"),
      until: (operation) =>
        done
          ? operation?.state === "succeeded" || operation?.state === "failed"
          : operation?.state === "running",
    }),
    Effect.timeout("20 seconds")
  )

describeMysql("Copying files between Relays as an operation", () => {
  layer(Transfers, { timeout: 60_000 })((it) => {
    it.effect(
      "copies the files and clears the source's artifact",
      () =>
        Effect.gen(function* () {
          yield* seed
          const handle = yield* startRelayTransferEffect(admin, request)

          const done = yield* operationOf(handle.transferId, true)

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(
            relays.pulls.get(handle.transferId)?.state,
            "completed"
          )
          assert.isFalse(relays.sources.has(handle.transferId))
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "ends as done when the person cancels it partway",
      () =>
        Effect.gen(function* () {
          yield* seed
          relays.holdPull = true
          const handle = yield* startRelayTransferEffect(admin, request)
          yield* operationOf(handle.transferId, false)
          yield* Effect.repeat(
            Effect.sync(() => relays.pulls.has(handle.transferId)),
            {
              schedule: Schedule.spaced("50 millis"),
              until: (started) => started,
            }
          )

          yield* cancelRelayTransferEffect(admin, handle)
          const done = yield* operationOf(handle.transferId, true)

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(
            relays.pulls.get(handle.transferId)?.state,
            "cancelled"
          )
          assert.isFalse(relays.sources.has(handle.transferId))
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "starts nothing more once cancelled while the source still packs",
      () =>
        Effect.gen(function* () {
          yield* seed
          relays.holdPacking = true
          const handle = yield* startRelayTransferEffect(admin, request)
          yield* operationOf(handle.transferId, false)

          yield* cancelRelayTransferEffect(admin, handle)
          relays.holdPacking = false
          const done = yield* operationOf(handle.transferId, true)

          assert.strictEqual(done?.state, "succeeded")
          assert.isFalse(relays.pulls.has(handle.transferId))
          assert.isFalse(relays.sources.has(handle.transferId))
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "is withdrawn when cancelled while it waits its turn",
      () =>
        Effect.gen(function* () {
          yield* seed
          const release = yield* holdDestination
          const handle = yield* startRelayTransferEffect(admin, request)

          yield* cancelRelayTransferEffect(admin, handle)
          yield* release
          const ended = yield* findOperation(
            relayTransfer.kind,
            handle.transferId
          )

          assert.strictEqual(ended?.state, "cancelled")
          assert.isFalse(relays.pulls.has(handle.transferId))
          assert.isFalse(relays.sources.has(handle.transferId))
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "carries on once a Relay that went offline is back",
      () =>
        Effect.gen(function* () {
          yield* seed
          const release = yield* holdDestination
          const handle = yield* startRelayTransferEffect(admin, request)
          // Offline by the time its turn comes, as after a Hearth restart.
          relays.offline = true
          yield* release
          yield* operationOf(handle.transferId, false)
          yield* Effect.sleep("1500 millis")
          relays.offline = false

          const done = yield* operationOf(handle.transferId, true)

          assert.strictEqual(done?.state, "succeeded")
          assert.strictEqual(
            relays.pulls.get(handle.transferId)?.state,
            "completed"
          )
        }).pipe(TestClock.withLive),
      30_000
    )

    it.effect(
      "fails with the Relay's reason",
      () =>
        Effect.gen(function* () {
          yield* seed
          relays.failPull = true
          const handle = yield* startRelayTransferEffect(admin, request)

          const done = yield* operationOf(handle.transferId, true)

          assert.strictEqual(done?.state, "failed")
          assert.include(done?.error ?? "", "The source went away")
          assert.isFalse(relays.sources.has(handle.transferId))
        }).pipe(TestClock.withLive),
      30_000
    )
  })
})
