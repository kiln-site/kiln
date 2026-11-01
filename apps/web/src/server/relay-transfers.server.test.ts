import { randomUUID } from "node:crypto"

import { assert, layer } from "@effect/vitest"
import { Cause, Deferred, Effect, Exit, Fiber, Layer } from "effect"
import { TestClock } from "effect/testing"
import { afterAll, vi } from "vite-plus/test"

import { Database } from "@/effect/database"
import { disposeAppRuntime } from "@/effect/runtime"
import type { AuthenticatedUser } from "@/lib/auth-session"
import { fileRootKey } from "@/lib/file-lanes"
import { exclusive } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"
import { testOperationsEngine } from "@/operations/test/engine"
import { TestDatabase, describeMysql, resetDatabase } from "@/test/database"
import {
  insertGrant,
  insertInstance,
  insertRelay,
  insertRows,
  insertUser,
} from "@/test/seed"

import { advanceRelayTransferEffect } from "./relay-transfers.server"

// The Relays are the only fake: the source has packed the transfer, the
// destination hasn't started pulling it, and every change asked of them is
// recorded.
const relayChanges = vi.hoisted(() => [] as Array<string>)
vi.mock("@/lib/relay-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/relay-connection")>()),
  relayRpc: async (_relay: unknown, operation: string, payload: unknown) => {
    if (operation === "transfer.pull.get") return null
    if (operation === "transfer.source.get") {
      return {
        createdAt: 0,
        entries: 1,
        error: null,
        expiresAt: 0,
        rootId: (payload as { rootId: string }).rootId,
        sha256: "a".repeat(64),
        size: 1,
        state: "ready",
        transferId: (payload as { transferId: string }).transferId,
      }
    }
    relayChanges.push(operation)
    return {}
  },
}))

afterAll(() => disposeAppRuntime())

const relayId = "r".repeat(43)
const sourceId = "a1".repeat(20)
const destinationId = "b2".repeat(20)
const user = {
  email: "mover@example.test",
  emailVerified: true,
  emailVerifiedAt: "2026-01-01T00:00:00.000Z",
  id: "mover",
  isDevelopmentBypass: false,
  name: "Mover",
  role: "user",
  twoFactorEnabled: false,
} satisfies AuthenticatedUser
const request = {
  destination: { path: "", relayId, rootId: destinationId },
  source: { paths: ["world"], relayId, rootId: sourceId },
}

// The person's grant on a game server, with just these permissions.
const grants = new Map<string, string>()
const allow = (instanceId: string, permissions: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const id = randomUUID()
    grants.set(instanceId, id)
    yield* insertGrant({
      id,
      relayId,
      resourceId: instanceId,
      resourceType: "instance",
      userId: user.id,
    })
    yield* insertRows(
      "access_selection",
      permissions.map((permission) => ({
        access_id: id,
        selection_key: permission,
        selection_kind: "permission",
      }))
    )
  })

const Lanes = testOperationsEngine(Layer.empty).pipe(
  Layer.provideMerge(TestDatabase)
)

describeMysql("Copying files between Relays", () => {
  layer(Lanes, { timeout: 60_000 })((it) => {
    it.effect(
      "doesn't start a pull once the person lost access while it waited its turn",
      () =>
        Effect.gen(function* () {
          yield* resetDatabase
          relayChanges.length = 0
          yield* insertUser(user.id, { emailVerifiedAt: new Date() })
          yield* insertRelay(relayId)
          yield* insertInstance(relayId, sourceId)
          yield* insertInstance(relayId, destinationId)
          yield* allow(sourceId, ["instance.files.read"])
          yield* allow(destinationId, ["instance.files.write"])

          // Something holds the destination whole, as a restore does.
          const released = yield* Deferred.make<void>()
          const holder = yield* inLanes(
            "test.restore",
            "Restoring this game server",
            [exclusive(fileRootKey(relayId, destinationId))],
            Deferred.await(released)
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.yieldNow

          const advancing = yield* advanceRelayTransferEffect(
            user,
            request,
            "transfer-one"
          ).pipe(Effect.forkChild({ startImmediately: true }))
          yield* Effect.sleep("200 millis")

          // Its access to the source goes while it waits.
          const database = yield* Database
          yield* database.execute(
            "test.revoke",
            "UPDATE kiln_access_grant SET state = 'revoked' WHERE id = ?",
            [grants.get(sourceId) ?? ""]
          )
          yield* Deferred.succeed(released, undefined)
          yield* Fiber.join(holder)
          const exit = yield* Fiber.await(advancing)

          // Refused for its access, checked again once its turn came.
          assert.isTrue(Exit.isFailure(exit))
          if (Exit.isFailure(exit)) {
            assert.match(
              String(Cause.squash(exit.cause)),
              /^PermissionDeniedError/
            )
          }
          assert.deepStrictEqual(relayChanges, [])
        }).pipe(TestClock.withLive),
      30_000
    )
  })
})
