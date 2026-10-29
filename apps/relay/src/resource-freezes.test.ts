import {
  defaultAppConfig,
  relayCreateDatabaseSchema,
  relayDeployAppSchema,
} from "@workspace/contracts"
import { Deferred, Effect, Fiber } from "effect"
import { afterEach, describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { LaneRejectedError, type LaneLock } from "./operation-lanes.js"
import {
  backupTaskLocks,
  controlRequestLocks,
  resourceReplaceLocks,
} from "./operation-plans.js"
import { fakeDocker } from "./test/docker.js"
import {
  relayHarness,
  TEST_NAMESPACE,
  type RelayHarness,
} from "./test/relay.js"

const serverId = "a".repeat(40)
const otherServerId = "b".repeat(40)
const databaseId = "d".repeat(40)
const appId = "e".repeat(40)
const deletion = "11111111-1111-4111-8111-111111111111"
const otherDeletion = "22222222-2222-4222-8222-222222222222"
const resolve = (reference: string) => reference
// No volume here belongs to an App, and no App names a volume.
const none = () => []
const quiet = async () => {}

afterEach(() => {
  vi.useRealTimers()
})

// Runs an operation the way the Relay admits it, reporting whether it ran.
async function attempt(
  harness: RelayHarness,
  label: string,
  locks: ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>>
) {
  const exit = await Effect.runPromise(
    Effect.exit(harness.lanes.run({ label, locks }, Effect.succeed("ran")))
  )
  if (exit._tag === "Success") return exit.value
  const error = exit.cause.reasons[0]
  return error?._tag === "Fail" && error.error instanceof LaneRejectedError
    ? error.error.message
    : "failed"
}

const control = (operation: string, payload: Record<string, unknown>) =>
  controlRequestLocks(
    operation as Parameters<typeof controlRequestLocks>[0],
    payload,
    resolve,
    none
  )!

const backupOf = (kind: "create" | "restore") =>
  backupTaskLocks(
    { kind, target: { id: serverId, kind: "instance" } } as Parameters<
      typeof backupTaskLocks
    >[0],
    resolve,
    none
  )

describe("resources frozen for deletion", () => {
  it("refuses every change to a frozen game server but its final backup and deletion", async () => {
    const harness = await relayHarness()
    // A live backup is running when the deletion asks to freeze the server,
    // and someone's start arrives after that, so both wait their turn.
    const backupDone = Deferred.makeUnsafe<void>()
    const backup = Effect.runFork(
      harness.lanes.run(
        { label: "backup.create", locks: backupOf("create") },
        Deferred.await(backupDone)
      )
    )
    const freeze = Effect.runFork(
      harness.lanes.run(
        {
          label: "resource.freeze",
          locks: resourceReplaceLocks("instance", serverId, resolve)!,
        },
        Effect.promise(() =>
          harness.freezes.freeze(
            { deletionId: deletion, id: serverId, kind: "instance" },
            quiet
          )
        )
      )
    )
    const start = attempt(
      harness,
      "instance.action",
      control("instance.action", { action: "start", instanceId: serverId })
    )
    await Effect.runPromise(Deferred.succeed(backupDone, undefined))
    await Effect.runPromise(Fiber.join(backup))
    await Effect.runPromise(Fiber.join(freeze))

    const refused = "This game server is being deleted"
    expect(await start).toBe(refused)
    expect(
      await attempt(
        harness,
        "instance.files.write",
        control("instance.files.write", { instanceId: serverId })
      )
    ).toBe(refused)
    expect(
      await attempt(
        harness,
        "browser.console",
        control("instance.console.write", { instanceId: serverId })
      )
    ).toBe(refused)
    expect(await attempt(harness, "backup.restore", backupOf("restore"))).toBe(
      refused
    )

    // Its final backup and its deletion still run, and nothing else waits.
    expect(await attempt(harness, "backup.create", backupOf("create"))).toBe(
      "ran"
    )
    expect(
      await attempt(
        harness,
        "instance.action",
        control("instance.action", {
          action: "start",
          instanceId: otherServerId,
        })
      )
    ).toBe("ran")
    expect(
      await attempt(
        harness,
        "instance.delete",
        control("instance.delete", { instanceId: serverId })
      )
    ).toBe("ran")
  })

  it("stops a frozen game server again when the Relay restarts, and only its own deletion lets it go", async () => {
    const harness = await relayHarness()
    const server = await harness.seedServer({ id: serverId, running: true })
    const frozen = {
      deletionId: deletion,
      id: serverId,
      kind: "instance",
    } as const
    const stop = async () => {
      const instance = await harness.docker.findInstance(serverId)
      if (instance)
        await harness.lifecycle.runInstanceAction(instance, "stop", [])
    }
    await harness.freezes.freeze(frozen, stop)
    expect(server.state.running).toBe(false)

    // Another deletion can neither take it over nor let it go.
    await expect(
      harness.freezes.freeze({ ...frozen, deletionId: otherDeletion }, quiet)
    ).rejects.toThrow("Another deletion of it is already under way")
    await harness.freezes.unfreeze(
      { ...frozen, deletionId: otherDeletion },
      async () => {}
    )

    // Started behind the Relay's back, as Docker might, then the Relay
    // restarts: still frozen, and stopped before anything runs.
    server.state.running = true
    const restarted = await harness.restart()
    expect(restarted.freezes.has("instance", serverId)).toBe(true)
    await restarted.freezes.reapply(async () => {
      const instance = await restarted.docker.findInstance(serverId)
      if (instance) {
        await restarted.lifecycle.runInstanceAction(instance, "stop", [])
      }
    })
    expect(server.state.running).toBe(false)
    const start = await Effect.runPromise(
      Effect.exit(
        restarted.lanes.run(
          {
            label: "instance.action",
            locks: control("instance.action", {
              action: "start",
              instanceId: serverId,
            }),
          },
          Effect.void
        )
      )
    )
    expect(start._tag).toBe("Failure")

    await restarted.freezes.unfreeze(frozen, async () => {})
    expect(restarted.freezes.has("instance", serverId)).toBe(false)
  })

  it("keeps a frozen database running for its dump, refusing every change Kiln would make to it", async () => {
    const harness = await relayHarness()
    await harness.databases.create(
      relayCreateDatabaseSchema.parse({
        databaseName: "kiln_app",
        engine: "postgres",
        id: databaseId,
        name: "Main database",
        password: "correct-horse-battery-staple-1",
        username: "kiln_user",
      })
    )
    await harness.freezes.freeze(
      { deletionId: deletion, id: databaseId, kind: "database" },
      quiet
    )

    const database = fakeDocker.container(
      `${TEST_NAMESPACE}-kiln-db-${databaseId}-database`
    )!
    expect(database.state.running).toBe(true)
    const refused = "This database is being deleted"
    for (const operation of [
      "database.action",
      "database.data.write",
      "database.dump.import",
      "database.wipe",
    ]) {
      expect(
        await attempt(harness, operation, control(operation, { databaseId }))
      ).toBe(refused)
    }
    expect(
      await attempt(
        harness,
        "backup.create",
        controlRequestLocks(
          "database.dump.export",
          { databaseId },
          resolve,
          none
        )!
      )
    ).toBe("ran")
  })

  it("stops a frozen App and keeps Docker from starting it, then gives back its restart policy", async () => {
    const harness = await relayHarness()
    await harness.apps.create({ id: appId, name: "Website" })
    fakeDocker.images.set("nginx:alpine", {})
    vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] })
    await harness.apps.deploy(
      relayDeployAppSchema.parse({
        appId,
        config: { ...defaultAppConfig, image: "nginx:alpine" },
        name: "Website",
      })
    )
    for (let step = 0; ; step += 1) {
      if ((await harness.apps.get(appId)).deployment?.state !== "running") break
      if (step > 10_000) throw new Error("The deployment never finished")
      await new Promise((resolve) => setImmediate(resolve))
      await vi.advanceTimersByTimeAsync(100)
    }
    vi.useRealTimers()
    const [container] = [...fakeDocker.containers.values()].filter(
      (candidate) => candidate.labels["kiln.app.id"] === appId
    )
    container!.restartPolicy = "on-failure"
    container!.restartMaximumRetryCount = 5
    const frozen = { deletionId: deletion, id: appId, kind: "app" } as const

    await harness.freezes.freeze(frozen, (record) =>
      harness.apps.quietForDeletion(appId, (restartPolicies) =>
        record({ restartPolicies })
      )
    )
    expect(container!.state.running).toBe(false)
    expect(container!.restartPolicy).toBe("no")
    // Recorded with the freeze, so a Relay that stops can still put it back.
    expect(
      (await Effect.runPromise(harness.state.listResourceFreezes()))[0]?.undo
    ).toEqual({
      restartPolicies: {
        [container!.id]: { maximumRetryCount: 5, name: "on-failure" },
      },
    })

    await harness.freezes.unfreeze(frozen, async (undo) => {
      await harness.apps.restoreRestartPolicies(undo.restartPolicies ?? {})
    })
    expect(container!.restartPolicy).toBe("on-failure")
    expect(container!.restartMaximumRetryCount).toBe(5)
    // It stays stopped: starting it again is someone's choice.
    expect(container!.state.running).toBe(false)
  })

  it("refuses every change to a frozen volume, even an App starting that mounts it, but its final backup and deletion", async () => {
    const harness = await relayHarness()
    const volumeId = "f".repeat(40)
    await harness.freezes.freeze(
      { deletionId: deletion, id: volumeId, kind: "volume" },
      quiet
    )
    // The App's configuration names the volume, so starting it reads it.
    const usesVolume = () => [volumeId]
    const startApp = () =>
      attempt(
        harness,
        "app.action",
        controlRequestLocks(
          "app.action",
          { action: "start", appId },
          resolve,
          usesVolume
        )!
      )
    const volumeBackup = backupTaskLocks(
      {
        kind: "create",
        target: { id: volumeId, kind: "volume" },
      } as Parameters<typeof backupTaskLocks>[0],
      resolve,
      none
    )

    const refused = "This volume is being deleted"
    expect(await startApp()).toBe(refused)
    expect(
      await attempt(
        harness,
        "relay.volumes.rename",
        control("relay.volumes.rename", { id: volumeId })
      )
    ).toBe(refused)
    expect(await attempt(harness, "backup.create", volumeBackup)).toBe("ran")
    expect(
      await attempt(
        harness,
        "relay.volumes.delete",
        control("relay.volumes.delete", { id: volumeId })
      )
    ).toBe("ran")

    await harness.freezes.forget("volume", volumeId)
    expect(await startApp()).toBe("ran")
  })

  it("forgets the freeze of a resource the Relay deleted", async () => {
    const harness = await relayHarness()
    await harness.freezes.freeze(
      { deletionId: deletion, id: databaseId, kind: "database" },
      quiet
    )
    await harness.freezes.forget("database", databaseId)

    expect(
      await attempt(
        harness,
        "database.action",
        control("database.action", { databaseId })
      )
    ).toBe("ran")
    expect(
      await Effect.runPromise(harness.state.listResourceFreezes())
    ).toEqual([])
  })
})
