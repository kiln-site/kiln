import { generateKeyPairSync } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { relayPeerTransfersV1Feature } from "@workspace/contracts"
import { Effect, Layer, Schedule } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { findOperation } from "@/operations/lanes"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import { insertRelay } from "@/test/seed"

import {
  cancelRelayTransferEffect,
  relayTransfer,
  startRelayTransferEffect,
} from "./relay-transfers.server"

// The Relays are the only fake: what each holds of a transfer, as their
// transfer workers keep it. A pull moves on a step each time it's asked
// about, unless it's held, and ends failed when told to.
const relays = vi.hoisted(() => ({
  failPull: false,
  holdPull: false,
  pulls: new Map<string, Record<string, unknown>>(),
  sources: new Map<string, Record<string, unknown>>(),
}))

vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayConnectionFeatures: () => new Set([relayPeerTransfersV1Feature]),
  relayConnectionState: () => ({ status: "authenticated" }),
  relayRpc: async (
    _relay: unknown,
    operation: string,
    payload: { transferId: string; rootId?: string }
  ) => {
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
          state: "ready",
          transferId,
        }
        relays.sources.set(transferId, source)
        return source
      }
      case "transfer.source.get":
        return relays.sources.get(transferId) ?? null
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
  relays.holdPull = false
  relays.pulls.clear()
  relays.sources.clear()
  yield* insertRelay("relay-one")
  yield* insertRelay("relay-two")
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
