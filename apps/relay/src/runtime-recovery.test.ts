import { mkdtempSync, rmSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { afterAll, afterEach, assert, describe, layer } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"
import { expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { loadConfig } from "./config.js"
import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import { INSTALLATION_MARKER_LABEL } from "./installation-marker.js"
import {
  RuntimeRecoveryManager,
  type RuntimeRecoveryObservation,
} from "./runtime-recovery.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness } from "./test/relay.js"

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

const makeManager = (environment: Record<string, string> = {}) =>
  Effect.gen(function* () {
    const manager = new RuntimeRecoveryManager(
      loadConfig({ NODE_ENV: "test", ...environment }),
      yield* RelayStateStore
    )
    yield* manager.initialize()
    return manager
  })

/** Reconciles at a fixed instant of the test clock. */
const reconcileAt = (
  manager: RuntimeRecoveryManager,
  time: number,
  observations: ReadonlyArray<RuntimeRecoveryObservation>
) => TestClock.setTime(time).pipe(Effect.andThen(manager.reconcile(observations)))

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
        const scheduled = yield* reconcileAt(manager, firstCrashAt, [firstCrash])
        assert.deepInclude(scheduled.get(instanceId)?.recovery, {
          attempt: 1,
          maxAttempts: 2,
          phase: "pending",
          reason: "process_exit",
          runtimeMs: 10_000,
        })

        const firstRetryAt = firstCrashAt + 5_000
        const restarting = yield* reconcileAt(manager, firstRetryAt, [firstCrash])
        assert.strictEqual(restarting.get(instanceId)?.recovery?.phase, "restarting")
        yield* dockerIdle
        assert.strictEqual(container.starts, 1)

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
        yield* dockerIdle

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

    it.effect("does not restart an incomplete Ember installation", () =>
      Effect.gen(function* () {
        const manager = yield* makeManager()
        const instanceId = "2".repeat(40)
        const container = server(instanceId, false)
        yield* TestClock.setTime(100)
        yield* manager.recordProvisioned(instanceId, "running")

        const result = yield* reconcileAt(manager, 200, [
          crashed(instanceId, {
            finishedAt: "2026-08-06T12:00:02.000Z",
            installationReady: false,
          }),
        ])
        yield* dockerIdle

        assert.deepStrictEqual(result.get(instanceId), {
          desiredState: "stopped",
          recovery: null,
        })
        assert.strictEqual(container.starts, 0)
      })
    )

    it.effect("persists an intentional power stop without recovery", () =>
      Effect.gen(function* () {
        const manager = yield* makeManager()
        const instanceId = "3".repeat(40)
        yield* TestClock.setTime(100)
        yield* manager.recordProvisioned(instanceId, "running")
        yield* manager.recordPowerAction(instanceId, "stop")

        const stopped = yield* reconcileAt(manager, 300, [
          observation(instanceId, {
            finishedAt: "2026-08-06T12:00:02.000Z",
            ready: false,
            running: false,
          }),
        ])

        assert.deepStrictEqual(stopped.get(instanceId), {
          desiredState: "stopped",
          recovery: null,
        })
      })
    )

    it.effect("lets a normal intentional shutdown finish gracefully", () =>
      Effect.gen(function* () {
        const manager = yield* makeManager()
        const instanceId = "e".repeat(40)
        const container = server(instanceId, true)
        yield* manager.recordProvisioned(instanceId, "running")
        yield* manager.recordPowerAction(instanceId, "stop")

        const stopping = yield* manager.reconcile([observation(instanceId)])
        yield* dockerIdle

        assert.deepStrictEqual(stopping.get(instanceId), {
          desiredState: "stopped",
          recovery: null,
        })
        assert.isTrue(container.state.running)
      })
    )

    it.effect("clears pending stop compensation on every power action", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const instanceId = "a".repeat(40)
        const container = server(instanceId, true)
        const initialManager = yield* makeManager()
        yield* initialManager.recordProvisioned(instanceId, "running")
        const initial = yield* state.getRuntimeRecovery(instanceId)
        if (!initial) return yield* Effect.die("expected a recovery record")
        yield* state.setRuntimeRecovery({
          ...initial,
          desiredState: "stopped",
          stopPending: true,
        })

        const manager = yield* makeManager()
        yield* manager.recordPowerAction(instanceId, "start")
        assert.isFalse(
          (yield* state.getRuntimeRecovery(instanceId))?.stopPending ?? true
        )
        yield* manager.recordPowerAction(instanceId, "stop")
        yield* manager.reconcile([observation(instanceId)])
        yield* dockerIdle

        assert.isFalse(
          (yield* state.getRuntimeRecovery(instanceId))?.stopPending ?? true
        )
        assert.isTrue(container.state.running)
      })
    )

    it.effect("clears stale stop compensation when running intent is observed", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const instanceId = "b".repeat(40)
        const initialManager = yield* makeManager()
        yield* initialManager.recordProvisioned(instanceId, "running")
        const initial = yield* state.getRuntimeRecovery(instanceId)
        if (!initial) return yield* Effect.die("expected a recovery record")
        yield* state.setRuntimeRecovery({ ...initial, stopPending: true })

        const manager = yield* makeManager()
        yield* manager.reconcile([observation(instanceId)])

        assert.isFalse(
          (yield* state.getRuntimeRecovery(instanceId))?.stopPending ?? true
        )
      })
    )

    it.effect("observes a manual start after the retry circuit opens", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const manager = yield* makeManager({ KILN_RELAY_CRASH_RETRY_LIMIT: "0" })
        const instanceId = "4".repeat(40)
        yield* TestClock.setTime(100)
        yield* manager.recordProvisioned(instanceId, "running")

        const failed = yield* reconcileAt(manager, 200, [
          crashed(instanceId, { finishedAt: "2026-08-06T12:00:02.000Z" }),
        ])
        assert.strictEqual(failed.get(instanceId)?.recovery?.phase, "failed")

        const manuallyStarted = yield* reconcileAt(
          manager,
          Date.parse("2026-08-06T12:01:10.000Z"),
          [observation(instanceId, { startedAt: "2026-08-06T12:01:00.000Z" })]
        )
        assert.deepStrictEqual(manuallyStarted.get(instanceId), {
          desiredState: "running",
          recovery: null,
        })
        assert.strictEqual(
          (yield* state.getRuntimeRecovery(instanceId))?.phase,
          "monitoring"
        )
      })
    )

    it.effect("does not persist recovery state for unmanaged containers", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const manager = yield* makeManager()
        const instanceId = "5".repeat(40)

        const result = yield* manager.reconcile([
          observation(instanceId, { managedByRelay: false }),
        ])

        assert.deepStrictEqual(result.get(instanceId), {
          desiredState: "running",
          recovery: null,
        })
        assert.isNull(yield* state.getRuntimeRecovery(instanceId))
      })
    )

    it.effect("preserves running intent while Docker is restarting", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const manager = yield* makeManager()
        const instanceId = "6".repeat(40)

        const result = yield* manager.reconcile([
          crashed(instanceId, {
            dockerRestartConfigured: true,
            restarting: true,
          }),
        ])

        assert.strictEqual(result.get(instanceId)?.desiredState, "running")
        assert.strictEqual(
          (yield* state.getRuntimeRecovery(instanceId))?.desiredState,
          "running"
        )
      })
    )

    it.effect("takes over a failed container with a legacy restart policy", () =>
      Effect.gen(function* () {
        const manager = yield* makeManager()
        const instanceId = "7".repeat(40)

        const result = yield* reconcileAt(
          manager,
          Date.parse("2026-08-06T12:00:02.000Z"),
          [
            crashed(instanceId, {
              dockerRestartConfigured: true,
              finishedAt: "2026-08-06T12:00:02.000Z",
            }),
          ]
        )

        assert.deepInclude(result.get(instanceId)?.recovery, {
          attempt: 1,
          phase: "pending",
          reason: "process_exit",
        })
      })
    )

    it.effect("does not block reconciliation on an in-flight Docker start", () =>
      Effect.gen(function* () {
        const manager = yield* makeManager({
          KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "0",
        })
        const instanceId = "8".repeat(40)
        server(instanceId, false)
        const start = fakeDocker.hold({ command: "start", target: service(instanceId) })
        yield* manager.recordProvisioned(instanceId, "running")
        yield* manager.reconcile([crashed(instanceId)])

        const reconcileFiber = yield* manager
          .reconcile([crashed(instanceId)])
          .pipe(Effect.forkChild)
        yield* Effect.promise(() => start.reached)
        const second = yield* manager.reconcile([crashed(instanceId)])

        assert.strictEqual(second.get(instanceId)?.recovery?.phase, "restarting")
        start.release()
        yield* Fiber.join(reconcileFiber)
      })
    )

    it.effect("stops a recovery start that lands after the user stopped the server", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const manager = yield* makeManager({
          KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "0",
        })
        const instanceId = "c".repeat(40)
        const container = server(instanceId, false)
        const start = fakeDocker.hold({ command: "start", target: container.name })
        const stop = fakeDocker.hold({ command: "stop", target: container.name })
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

    it.effect("retries a failed compensating stop after a Relay restart", () =>
      Effect.gen(function* () {
        const state = yield* RelayStateStore
        const environment = { KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "0" }
        const manager = yield* makeManager(environment)
        const instanceId = "d".repeat(40)
        const container = server(instanceId, false)
        const start = fakeDocker.hold({ command: "start", target: container.name })
        const firstStop = fakeDocker.hold({ command: "stop", target: container.name })
        yield* manager.recordProvisioned(instanceId, "running")
        yield* manager.reconcile([crashed(instanceId)])
        yield* manager.reconcile([crashed(instanceId)])
        yield* Effect.promise(() => start.reached)
        yield* manager.recordPowerAction(instanceId, "stop")
        start.release()
        yield* Effect.promise(() => firstStop.reached)
        firstStop.fail("Docker stop failed")
        yield* dockerIdle

        assert.isTrue(container.state.running)
        assert.isTrue((yield* state.getRuntimeRecovery(instanceId))?.stopPending)

        const restarted = yield* makeManager(environment)
        const retry = fakeDocker.hold({ command: "stop", target: container.name })
        yield* restarted.reconcile([observation(instanceId)])
        yield* Effect.promise(() => retry.reached)
        retry.release()
        yield* dockerIdle

        assert.isFalse(container.state.running)
        assert.deepStrictEqual(restarted.snapshot(instanceId), {
          desiredState: "stopped",
          recovery: null,
        })
        yield* restarted.reconcile([crashed(instanceId, { exitCode: 0 })])
        assert.isFalse((yield* state.getRuntimeRecovery(instanceId))?.stopPending)
      })
    )

    it.effect("counts a start Docker never confirms against the retry budget", () =>
      Effect.gen(function* () {
        const manager = yield* makeManager({
          KILN_RELAY_CRASH_RETRY_DELAY_SECONDS: "0",
          KILN_RELAY_CRASH_RETRY_LIMIT: "2",
        })
        const instanceId = "9".repeat(40)
        const container = server(instanceId, false)
        const stopped = crashed(instanceId)
        yield* TestClock.setTime(100)
        yield* manager.recordProvisioned(instanceId, "running")
        yield* reconcileAt(manager, 200, [stopped])
        const restarting = yield* reconcileAt(manager, 201, [stopped])
        yield* dockerIdle

        const confirmationAt = Date.parse(
          restarting.get(instanceId)?.recovery?.nextAttemptAt ?? ""
        )
        assert.isAbove(confirmationAt, 201)
        yield* reconcileAt(manager, confirmationAt - 1, [stopped])
        assert.strictEqual(container.starts, 1)

        // Docker accepted the start, but the container never came up.
        const retry = yield* reconcileAt(manager, confirmationAt, [stopped])
        assert.deepInclude(retry.get(instanceId)?.recovery, {
          attempt: 2,
          phase: "pending",
          reason: "start_failed",
        })
        assert.strictEqual(container.starts, 1)
      })
    )
  })
})

describe("runtime recovery through Docker discovery", () => {
  const id = "f".repeat(40)

  it("takes restart ownership away from a legacy Docker restart policy", async () => {
    const harness = await relayHarness()
    const container = await harness.seedServer({
      id,
      restartPolicy: "unless-stopped",
      running: true,
    })

    await harness.docker.inspectInstances()

    expect(container.restartPolicy).toBe("no")
  })

  it.each([
    { installed: false, expected: { desiredState: "stopped", recovery: null } },
    {
      installed: true,
      expected: { desiredState: "running", recovery: { phase: "pending" } },
    },
  ])(
    "recovers an exited server only once its installation finished (installed=$installed)",
    async ({ installed, expected }) => {
      const harness = await relayHarness()
      const container = await harness.seedServer({
        exitCode: 1,
        finishedAt: "2026-08-05T20:01:00.000Z",
        id,
        labels: { [INSTALLATION_MARKER_LABEL]: ".kiln-ember-installed" },
        restartPolicy: "unless-stopped",
        startedAt: "2026-08-05T20:00:00.000Z",
      })
      if (installed) {
        await writeFile(
          join(harness.config.rootDirectory, id, ".kiln-ember-installed"),
          ""
        )
      }

      const [instance] = await harness.docker.inspectInstances()

      expect(instance).toMatchObject(expected)
      expect(container.state.running).toBe(false)
    }
  )
})
