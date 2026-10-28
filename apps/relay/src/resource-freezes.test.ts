import { join } from "node:path"

import { Deferred, Effect, Fiber, ManagedRuntime } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { makeRelayStateLayer, RelayStateStore } from "./effect/state.js"
import {
  LaneRejectedError,
  OperationLanes,
  type LaneLock,
} from "./operation-lanes.js"
import {
  backupTaskLocks,
  controlRequestLocks,
  resourceReplaceLocks,
} from "./operation-plans.js"
import { ResourceFreezes } from "./resource-freezes.js"
import { relayHarness } from "./test/relay.js"

const serverId = "a".repeat(40)
const otherServerId = "b".repeat(40)
const deletion = "11111111-1111-4111-8111-111111111111"
const otherDeletion = "22222222-2222-4222-8222-222222222222"
const resolve = (reference: string) => reference

async function setup() {
  const harness = await relayHarness()
  const freezes = await Effect.runPromise(ResourceFreezes.load(harness.state))
  const lanes = new OperationLanes({
    refuse: (label, locks) => freezes.refusal(label, locks),
  })
  // Runs an operation the way the Relay admits it, reporting whether it ran.
  const attempt = async (
    label: string,
    locks: Parameters<OperationLanes["run"]>[0]["locks"]
  ) => {
    const exit = await Effect.runPromise(
      Effect.exit(lanes.run({ label, locks }, Effect.succeed("ran")))
    )
    if (exit._tag === "Success") return exit.value
    const error = exit.cause.reasons[0]
    return error?._tag === "Fail" && error.error instanceof LaneRejectedError
      ? error.error.message
      : "failed"
  }
  return { attempt, freezes, harness, lanes }
}

const control = (operation: string, payload: Record<string, unknown>) =>
  controlRequestLocks(
    operation as Parameters<typeof controlRequestLocks>[0],
    payload,
    resolve
  )!

describe("resources frozen for deletion", () => {
  it("refuses every change to a frozen game server but its final backup and deletion", async () => {
    const { attempt, freezes, lanes } = await setup()
    const stopped: Array<string> = []
    // A live backup is running when the deletion asks to freeze the server,
    // and someone's start arrives after that, so both wait their turn.
    const backupDone = Deferred.makeUnsafe<void>()
    const backup = Effect.runFork(
      lanes.run(
        {
          label: "backup.create",
          locks: backupTaskLocks(
            {
              kind: "create",
              target: { id: serverId, kind: "instance" },
            } as Parameters<typeof backupTaskLocks>[0],
            resolve
          ),
        },
        Deferred.await(backupDone)
      )
    )
    const freeze = Effect.runFork(
      lanes.run(
        {
          label: "resource.freeze",
          locks: resourceReplaceLocks("instance", serverId, resolve)!,
        },
        Effect.promise(() =>
          freezes.freeze(
            { deletionId: deletion, id: serverId, kind: "instance" },
            async () => {
              stopped.push(serverId)
            }
          )
        )
      )
    )
    const start = attempt(
      "instance.action",
      control("instance.action", { action: "start", instanceId: serverId })
    )
    await Effect.runPromise(Deferred.succeed(backupDone, undefined))
    await Effect.runPromise(Fiber.join(backup))
    await Effect.runPromise(Fiber.join(freeze))

    expect(stopped).toEqual([serverId])
    expect(await start).toBe("This game server is being deleted")
    expect(
      await attempt(
        "instance.files.write",
        control("instance.files.write", { instanceId: serverId })
      )
    ).toBe("This game server is being deleted")
    expect(
      await attempt(
        "browser.console",
        control("instance.console.write", { instanceId: serverId })
      )
    ).toBe("This game server is being deleted")
    expect(
      await attempt(
        "backup.restore",
        backupTaskLocks(
          {
            kind: "restore",
            target: { id: serverId, kind: "instance" },
          } as Parameters<typeof backupTaskLocks>[0],
          resolve
        )
      )
    ).toBe("This game server is being deleted")

    // Its final backup and its deletion still run, and nothing else waits.
    expect(
      await attempt(
        "backup.create",
        backupTaskLocks(
          {
            kind: "create",
            target: { id: serverId, kind: "instance" },
          } as Parameters<typeof backupTaskLocks>[0],
          resolve
        )
      )
    ).toBe("ran")
    expect(
      await attempt(
        "instance.action",
        control("instance.action", {
          action: "start",
          instanceId: otherServerId,
        })
      )
    ).toBe("ran")
    expect(
      await attempt(
        "instance.delete",
        control("instance.delete", { instanceId: serverId })
      )
    ).toBe("ran")
  })

  it("keeps a freeze across a restart, and only its own deletion lets it go", async () => {
    const { attempt, freezes, harness } = await setup()
    const frozen = { deletionId: deletion, id: serverId, kind: "instance" } as const
    await freezes.freeze(frozen, async () => {})

    // Another deletion can neither take it over nor let it go.
    await expect(
      freezes.freeze({ ...frozen, deletionId: otherDeletion }, async () => {})
    ).rejects.toThrow("Another deletion of it is already under way")
    await freezes.unfreeze({ ...frozen, deletionId: otherDeletion })

    const reopened = ManagedRuntime.make(
      makeRelayStateLayer(join(harness.config.dataDirectory, "relay.sqlite"))
    )
    try {
      const restarted = await Effect.runPromise(
        ResourceFreezes.load(await reopened.runPromise(RelayStateStore))
      )
      expect(restarted.has("instance", serverId)).toBe(true)
      expect(
        restarted.refusal(
          "instance.action",
          control("instance.action", {
            action: "stop",
            instanceId: serverId,
          }) as ReadonlyArray<LaneLock>
        )
      ).toBe("This game server is being deleted")
    } finally {
      await reopened.dispose()
    }

    await freezes.unfreeze(frozen)
    expect(
      await attempt(
        "instance.action",
        control("instance.action", { action: "start", instanceId: serverId })
      )
    ).toBe("ran")
  })

  it("forgets the freeze of a resource the Relay deleted", async () => {
    const { attempt, freezes, harness } = await setup()
    await freezes.freeze(
      { deletionId: deletion, id: "c".repeat(40), kind: "database" },
      async () => {}
    )
    await freezes.forget("database", "c".repeat(40))

    expect(
      await attempt(
        "database.action",
        control("database.action", { databaseId: "c".repeat(40) })
      )
    ).toBe("ran")
    expect(
      await Effect.runPromise(harness.state.listResourceFreezes())
    ).toEqual([])
  })
})
