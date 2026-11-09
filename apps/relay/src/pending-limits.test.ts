import { resourceLimitsEqual, type ResourceLimits } from "@workspace/contracts"
import { Effect } from "effect"
import { describe, expect, it, vi } from "vite-plus/test"

vi.mock("./command.js", () => import("./test/docker.js"))

import { controlRequestLocks } from "./operation-plans.js"
import { fakeDocker } from "./test/docker.js"
import { relayHarness, type RelayHarness } from "./test/relay.js"

const server = "a".repeat(12)
const GIBIBYTE = 1024 ** 3

const saved: ResourceLimits = {
  cpuMillis: 1500,
  diskBytes: 2 * GIBIBYTE,
  memoryBytes: GIBIBYTE,
}

function current(name: string) {
  const container = fakeDocker.container(name)
  if (!container) throw new Error(`${name} isn't there`)
  return container
}

// Runs a control request's work as the control socket admits it.
function control(
  harness: RelayHarness,
  operation: "instance.action" | "instance.limits.write",
  payload: Record<string, unknown>,
  work: () => Promise<unknown>
) {
  return Effect.runPromise(
    harness.lanes.run(
      {
        label: operation,
        locks: controlRequestLocks(
          operation,
          payload,
          (reference) => reference,
          () => []
        )!,
      },
      Effect.promise(work)
    )
  )
}

async function runningServer(harness: RelayHarness) {
  const { id, memoryBytes, name } = await harness.seedServer({
    id: server,
    running: true,
  })
  const instance = await harness.docker.findInstance(server)
  if (!instance) throw new Error("The server wasn't found")
  return { container: { id, memoryBytes, name }, instance }
}

describe("limits saved for a game server's next restart", () => {
  it("leave the running container alone until it restarts", async () => {
    const harness = await relayHarness()
    const { container, instance } = await runningServer(harness)

    await harness.lifecycle.setInstanceLimits(instance, saved)

    expect(await harness.docker.pendingLimits(server)).toEqual(saved)
    const running = current(container.name)
    expect(running.id).toBe(container.id)
    expect(running.state.running).toBe(true)
    expect(running.memoryBytes).toBe(container.memoryBytes)

    const updated = await harness.lifecycle.runInstanceAction(
      instance,
      "restart",
      []
    )

    expect(resourceLimitsEqual(updated.limits, saved)).toBe(true)
    expect(await harness.docker.pendingLimits(server)).toBeNull()
    const replaced = current(container.name)
    expect(replaced.state.running).toBe(true)
    expect(replaced.memoryBytes).toBe(GIBIBYTE)
    expect(replaced.nanoCpus).toBe(1_500_000_000)
  })

  it("saved during a restart wait for it, and survive it", async () => {
    const harness = await relayHarness()
    const { container, instance } = await runningServer(harness)
    await harness.lifecycle.setInstanceLimits(instance, saved)
    const stop = fakeDocker.hold({ command: "stop", target: container.name })

    const restart = control(
      harness,
      "instance.action",
      { action: "restart", instanceId: server },
      () => harness.lifecycle.runInstanceAction(instance, "restart", [])
    )
    await stop.reached
    const newer = { ...saved, memoryBytes: 2 * GIBIBYTE }
    const save = control(
      harness,
      "instance.limits.write",
      { instanceId: server },
      async () => {
        const current = await harness.docker.findInstance(server)
        await harness.lifecycle.setInstanceLimits(current ?? instance, newer)
      }
    )
    stop.release()
    await Promise.all([restart, save])

    expect(current(container.name).memoryBytes).toBe(GIBIBYTE)
    expect(await harness.docker.pendingLimits(server)).toEqual(newer)
  })

  it.each(["create", "start"])(
    "stay saved when a restart fails to %s, for the next one",
    async (command) => {
      const harness = await relayHarness()
      const { container, instance } = await runningServer(harness)
      await harness.lifecycle.setInstanceLimits(instance, saved)
      fakeDocker.failNext({ command }, "no space left on device")

      await expect(
        harness.lifecycle.runInstanceAction(instance, "restart", [])
      ).rejects.toThrow(/could not apply/u)

      expect(await harness.docker.pendingLimits(server)).toEqual(saved)
      const restored = await harness.docker.findInstance(server)
      if (!restored) throw new Error("The server didn't come back")
      expect(current(container.name).memoryBytes).toBe(container.memoryBytes)

      await harness.lifecycle.runInstanceAction(restored, "restart", [])

      expect(current(container.name).memoryBytes).toBe(GIBIBYTE)
      expect(await harness.docker.pendingLimits(server)).toBeNull()
    }
  )
})
