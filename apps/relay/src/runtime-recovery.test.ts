import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, assert, describe, layer } from "@effect/vitest"
import { Deferred, Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { loadConfig } from "./config.js"
import { OperationLanes } from "./operation-lanes.js"
import { instanceLifecycleLocks } from "./operation-plans.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import {
  RuntimeRecoveryManager,
  type RuntimeRecoveryObservation,
} from "./runtime-recovery.js"
import { fakeDocker } from "./test/docker.js"

const testDirectory = mkdtempSync(join(tmpdir(), "kiln-runtime-recovery-"))

afterAll(() => {
  rmSync(testDirectory, { force: true, recursive: true })
})

afterEach(() => {
  fakeDocker.reset()
})

function service(instanceId: string) {
  return `kiln-${instanceId.slice(0, 8)}`
}

/** The server's container, which recovery starts and stops through Docker. */
function server(instanceId: string, running: boolean) {
  return fakeDocker.addContainer({ name: service(instanceId), running })
}

function observation(
  instanceId: string,
  overrides: Partial<RuntimeRecoveryObservation> = {}
): RuntimeRecoveryObservation {
  return {
    dockerRestartConfigured: false,
    exitCode: 0,
    finishedAt: "0001-01-01T00:00:00.000Z",
    installationReady: true,
    instanceId,
    managedByRelay: true,
    oomKilled: false,
    ready: true,
    restarting: false,
    running: true,
    service: service(instanceId),
    startedAt: "2026-08-06T12:00:00.000Z",
    transitionActive: false,
    ...overrides,
  }
}

const crashed = (
  instanceId: string,
  overrides: Partial<RuntimeRecoveryObservation> = {}
) =>
  observation(instanceId, {
    exitCode: 1,
    ready: false,
    running: false,
    ...overrides,
  })

const dockerIdle = Effect.promise(() => fakeDocker.idle())

// A recovery restart runs on its own fiber and does async work before it
// calls Docker, so under load it can outlast a quiet moment on the socket.
const startsReached = (
  container: { readonly starts: number },
  starts: number
) =>
  Effect.promise(() =>
    vi.waitFor(() => assert.strictEqual(container.starts, starts))
  ).pipe(Effect.andThen(dockerIdle))

const makeManager = (
  environment: Record<string, string> = {},
  lanes = new OperationLanes()
) =>
  Effect.gen(function* () {
    const config = loadConfig({ NODE_ENV: "test", ...environment })
    config.dockerSocket = yield* Effect.promise(() => fakeDocker.listen())
    const manager = new RuntimeRecoveryManager(
      config,
      yield* RelayStateStore,
      lanes
    )
    yield* manager.initialize()
    return manager
  })

/** Reconciles at a fixed instant of the test clock. */
const reconcileAt = (
  manager: RuntimeRecoveryManager,
  time: number,
  observations: ReadonlyArray<RuntimeRecoveryObservation>
) =>
  TestClock.setTime(time).pipe(Effect.andThen(manager.reconcile(observations)))

describe("runtime recovery", () => {
  layer(makeRelayStateLayer(join(testDirectory, "relay.sqlite")))((it) => {
    it.effect("restarts twice, then opens the crash-loop circuit", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const manager = yield* makeManager({
          KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "5",
          KILN_RELAY_CRASH_RETRY_LIMIT: "2",
          KILN_RELAY_CRASH_STABILITY_SECONDS: "300",
        })
        const instanceId = "1".repeat(40)
        const container = server(instanceId, false)
        const firstStartedAt = "2026-08-06T12:00:00.000Z"
        const firstStartedAtMs = Date.parse(firstStartedAt)
        yield* reconcileAt(manager, firstStartedAtMs, [
          observation(instanceId, { startedAt: firstStartedAt }),
        ])

        const firstCrashAt = firstStartedAtMs + 10_000
        const firstCrash = crashed(instanceId, {
          finishedAt: new Date(firstCrashAt).toISOString(),
          startedAt: firstStartedAt,
        })
        const scheduled = yield* reconcileAt(manager, firstCrashAt, [
          firstCrash,
        ])
        assert.deepInclude(scheduled.get(instanceId)?.recovery, {
          attempt: 1,
          maxAttempts: 2,
          phase: "pending",
          reason: "process_exit",
          runtimeMs: 10_000,
        })

        const firstRetryAt = firstCrashAt + 5_000
        const restarting = yield* reconcileAt(manager, firstRetryAt, [
          firstCrash,
        ])
        assert.strictEqual(
          restarting.get(instanceId)?.recovery?.phase,
          "restarting"
        )
        yield* startsReached(container, 1)

        const secondStartedAt = new Date(firstRetryAt + 1_000).toISOString()
        yield* reconcileAt(manager, firstRetryAt + 2_000, [
          observation(instanceId, { startedAt: secondStartedAt }),
        ])
        assert.isNull(manager.snapshot(instanceId)?.recovery)

        const secondCrashAt = firstRetryAt + 3_000
        const secondCrash = crashed(instanceId, {
          exitCode: 137,
          finishedAt: new Date(secondCrashAt).toISOString(),
          oomKilled: true,
          startedAt: secondStartedAt,
        })
        fakeDocker.exit(container.name, { exitCode: 137, oomKilled: true })
        const oom = yield* reconcileAt(manager, secondCrashAt, [secondCrash])
        assert.deepInclude(oom.get(instanceId)?.recovery, {
          attempt: 2,
          oomKilled: true,
          phase: "pending",
          reason: "out_of_memory",
        })

        const secondRetryAt = secondCrashAt + 15_000
        yield* reconcileAt(manager, secondRetryAt, [secondCrash])
        yield* startsReached(container, 2)

        const exhausted = yield* reconcileAt(manager, secondRetryAt + 2_000, [
          crashed(instanceId, {
            finishedAt: new Date(secondRetryAt + 2_000).toISOString(),
            startedAt: new Date(secondRetryAt + 1_000).toISOString(),
          }),
        ])
        assert.deepInclude(exhausted.get(instanceId)?.recovery, {
          attempt: 2,
          phase: "failed",
          reason: "process_exit",
        })
        yield* dockerIdle
        assert.strictEqual(container.starts, 2)

        const persisted = yield* state.getRuntimeRecovery(instanceId)
        assert.strictEqual(persisted?.phase, "failed")
        assert.strictEqual(persisted?.desiredState, "running")
      })
    )

    it.effect("waits for a power change in progress and gives way to it", () =>
      Effect.gen(function* () {
        const lanes = new OperationLanes()
        const manager = yield* makeManager(
          { KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "5" },
          lanes
        )
        const instanceId = "9".repeat(40)
        const container = server(instanceId, false)
        const startedAt = "2026-08-06T12:00:00.000Z"
        const startedAtMs = Date.parse(startedAt)
        yield* reconcileAt(manager, startedAtMs, [
          observation(instanceId, { startedAt }),
        ])
        const crash = crashed(instanceId, {
          finishedAt: new Date(startedAtMs + 10_000).toISOString(),
          startedAt,
        })
        yield* reconcileAt(manager, startedAtMs + 10_000, [crash])

        // Someone's stop is running when the retry comes due.
        const release = yield* Deferred.make<void>()
        const stop = yield* lanes
          .run(
            { label: "stop", locks: instanceLifecycleLocks(instanceId) },
            Deferred.await(release).pipe(
              Effect.andThen(manager.recordPowerAction(instanceId, "stop"))
            )
          )
          .pipe(Effect.forkChild({ startImmediately: true }))
        const retry = yield* reconcileAt(manager, startedAtMs + 15_000, [crash])
        assert.strictEqual(retry.get(instanceId)?.recovery?.phase, "restarting")
        yield* dockerIdle
        assert.strictEqual(container.starts, 0)

        yield* Deferred.succeed(release, undefined)
        yield* Fiber.join(stop)
        yield* Effect.yieldNow
        yield* dockerIdle
        // The stop won: recovery doesn't start the server it stopped.
        assert.strictEqual(container.starts, 0)
        assert.deepStrictEqual(manager.snapshot(instanceId), {
          desiredState: "stopped",
          recovery: null,
        })
      })
    )

    it.effect(
      "stops a recovery start that lands after the user stopped the server",
      () =>
        Effect.gen(function* () {
          const state = yield* RelayStateStore
          const manager = yield* makeManager({
            KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "0",
          })
          const instanceId = "c".repeat(40)
          const container = server(instanceId, false)
          const start = fakeDocker.hold({
            command: "start",
            target: container.name,
          })
          const stop = fakeDocker.hold({
            command: "stop",
            target: container.name,
          })
          yield* manager.recordProvisioned(instanceId, "running")
          yield* manager.reconcile([crashed(instanceId)])
          yield* manager.reconcile([crashed(instanceId)])
          yield* Effect.promise(() => start.reached)

          yield* manager.recordPowerAction(instanceId, "stop")
          start.release()
          yield* Effect.promise(() => stop.reached)
          // Reconciliation keeps working while the compensating stop is running.
          const during = yield* manager.reconcile([observation(instanceId)])
          assert.strictEqual(during.get(instanceId)?.desiredState, "stopped")
          stop.release()
          yield* dockerIdle

          assert.isFalse(container.state.running)
          assert.deepStrictEqual(manager.snapshot(instanceId), {
            desiredState: "stopped",
            recovery: null,
          })
          assert.strictEqual(
            (yield* state.getRuntimeRecovery(instanceId))?.desiredState,
            "stopped"
          )
        })
    )
  })
})
