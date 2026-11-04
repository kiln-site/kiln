import { totalmem } from "node:os"

import { assert, describe, it } from "@effect/vitest"
import { Effect, Fiber } from "effect"
import { TestClock } from "effect/testing"

import { NO_RESOURCE_LIMITS } from "@workspace/contracts"

import { DockerEngineError, type DockerEngine } from "./docker-engine.js"
import { OperationLanes } from "./operation-lanes.js"
import {
  assertResourceLimitsFit,
  ResourceAllocations,
} from "./resource-limits.js"
import { WorkloadSlice } from "./workload-slice.js"

const MEBIBYTE = 1024 ** 2

// The slice as the host holds it, driven by what the scripts ask for.
class Host {
  readonly enabled = true
  limitBytes: number | null = null
  populated = false
  /** What the kernel reports, when it isn't what systemd was told. */
  kernelBytes: number | null = null
  /** Answers about the slice with this, instead of what's there. */
  garbledState: string | null = null
  /** How many looks at the slice go through before that starts. */
  readsBeforeGarbled = 0
  /** Refuses to lift the limit. */
  refusesClear = false
  /** Holds up the check on what the kernel enforces. */
  checkDelay = "0 millis"

  runOnce(script: string) {
    if (this.refusesClear && script.includes("MemoryMax=infinity")) {
      return Effect.fail(
        new DockerEngineError({
          cause: null,
          operation: "run",
          reason: "The kernel still enforces the workload memory limit",
        })
      )
    }
    const delay = script.includes("MemoryMax=infinity")
      ? "0 millis"
      : script.includes("memory.max")
        ? this.checkDelay
        : "0 millis"
    return Effect.sleep(delay as "0 millis").pipe(Effect.andThen(this.#run(script)))
  }

  #run(script: string) {
    return Effect.sync(() => {
      if (script.includes("MemoryMax=infinity")) {
        this.limitBytes = null
        return ""
      }
      const applied = /MemoryMax=(\d+)/u.exec(script)
      if (applied) {
        this.limitBytes = Number(applied[1])
        return ""
      }
      if (script.includes("memory.max")) {
        const wanted = /= "(\d+)" \]/u.exec(script)?.[1]
        return String(this.kernelBytes ?? this.limitBytes) === wanted
          ? "enforced\n"
          : ""
      }
      if (this.garbledState !== null && this.readsBeforeGarbled-- <= 0) {
        return this.garbledState
      }
      const limit = this.limitBytes ?? "infinity"
      return `${limit} ${this.populated ? 1 : 0}\n`
    })
  }
}

// Docker, as far as the probe sees it.
class Engine {
  readonly containers = new Set<string>()
  placedWorkloads: ReadonlyArray<{ readonly Id: string }> = []
  refusesStart = false

  listContainers = () => Effect.succeed(this.placedWorkloads)

  createContainer = (name: string) =>
    Effect.sync(() => {
      this.containers.add(name)
      return { Id: name }
    })

  info = () =>
    Effect.succeed({
      CgroupDriver: "systemd",
      CgroupVersion: "2",
      SecurityOptions: [],
    })

  removeContainer = (name: string) =>
    Effect.sync(() => void this.containers.delete(name))

  startContainer = () =>
    this.refusesStart
      ? Effect.fail(
          new DockerEngineError({
            cause: null,
            operation: "POST /containers/start",
            reason: "cgroup parent refused",
          })
        )
      : Effect.void
}

const assignedElsewhere = (bytes: number) => async () => [
  {
    id: "other",
    limits: { ...NO_RESOURCE_LIMITS, memoryBytes: bytes },
  },
]

function setup(
  options: {
    readonly assigned?: number
    readonly workloadMemoryLimit?: boolean
  } = {}
) {
  const host = new Host()
  const engine = new Engine()
  const allocations = new ResourceAllocations({
    mode: "node",
    reservedMemoryBytes: 1024 ** 3,
  })
  allocations.register("server", assignedElsewhere(options.assigned ?? 0))
  const slice = new WorkloadSlice(
    {
      resourceNamespace: "",
      workloadMemoryLimit: options.workloadMemoryLimit ?? true,
    },
    engine as unknown as DockerEngine,
    host,
    allocations,
    new OperationLanes()
  )
  const wanted =
    Math.floor(allocations.assignableMemoryBytes / MEBIBYTE) * MEBIBYTE
  return { allocations, engine, host, slice, wanted }
}

describe("the workload slice", () => {
  it.effect("places workloads once the kernel enforces the limit", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup()
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, wanted)
      assert.strictEqual(allocations.workloadLimit.limitBytes, wanted)
      assert.isDefined(allocations.workloadSpec().cgroupParent)
    })
  )

  it.effect("leaves a node over its budget the room it has assigned", () =>
    Effect.gen(function* () {
      const assigned = totalmem() - 256 * MEBIBYTE
      const { host, slice } = setup({ assigned })
      yield* slice.reconcile()
      assert.isAtLeast(host.limitBytes!, assigned - MEBIBYTE)
    })
  )

  it.effect("never lowers a limit, even on an empty slice", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup()
      const higher = wanted + 64 * MEBIBYTE
      host.limitBytes = higher
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, higher)
      assert.strictEqual(allocations.workloadLimit.limitBytes, higher)
    })
  )

  it.effect("doesn't trim a limit past the node's memory", () =>
    Effect.gen(function* () {
      const { host, slice } = setup()
      const past = totalmem() + 1024 * MEBIBYTE
      const whole = Math.ceil(past / MEBIBYTE) * MEBIBYTE
      host.limitBytes = whole
      host.populated = true
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, whole)
    })
  )

  it.effect("rounds a limit between whole mebibytes up, not down", () =>
    Effect.gen(function* () {
      const { host, slice, wanted } = setup()
      const higher = wanted + 64 * MEBIBYTE
      host.limitBytes = higher + 4096
      host.populated = true
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, higher + MEBIBYTE)
    })
  )

  it.effect("raises a limit below the target", () =>
    Effect.gen(function* () {
      const { host, slice, wanted } = setup()
      host.limitBytes = wanted - 64 * MEBIBYTE
      host.populated = true
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, wanted)
    })
  )

  it.effect("sets no tight first limit where workloads were left placed", () =>
    Effect.gen(function* () {
      const { engine, host, slice, wanted } = setup()
      engine.placedWorkloads = [{ Id: "stopped" }]
      yield* slice.reconcile()
      assert.isAbove(host.limitBytes!, wanted)
    })
  )

  it.effect("leaves nothing behind when a first setup can't be confirmed", () =>
    Effect.gen(function* () {
      const { allocations, host, slice } = setup()
      host.kernelBytes = 1
      yield* slice.reconcile()
      assert.isNull(host.limitBytes)
      assert.isNull(allocations.workloadLimit.limitBytes)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )

  it.effect("keeps a working limit when a later check fails", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup()
      host.limitBytes = wanted
      host.populated = true
      host.kernelBytes = 1
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, wanted)
      assert.strictEqual(allocations.workloadLimit.limitBytes, wanted)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )

  it.effect("reports a limit a failed check left raised", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup()
      host.limitBytes = wanted - 64 * MEBIBYTE
      host.kernelBytes = 1
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, wanted)
      assert.strictEqual(allocations.workloadLimit.limitBytes, wanted)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )

  it.effect("undoes a first setup that runs out of time", () =>
    Effect.gen(function* () {
      const { allocations, host, slice } = setup()
      host.checkDelay = "10 minutes"
      const fiber = yield* Effect.forkChild(slice.reconcile())
      yield* TestClock.adjust("3 minutes")
      yield* Fiber.join(fiber)
      assert.isNull(host.limitBytes)
      assert.isNull(allocations.workloadLimit.limitBytes)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )

  it.effect("removes a probe Docker wouldn't start", () =>
    Effect.gen(function* () {
      const { allocations, engine, host, slice } = setup()
      engine.refusesStart = true
      yield* slice.reconcile()
      assert.strictEqual(engine.containers.size, 0)
      assert.isNull(host.limitBytes)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )

  it.effect("clears the limit when a Relay opts out", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup({
        workloadMemoryLimit: false,
      })
      host.limitBytes = wanted
      host.populated = true
      yield* slice.reconcile()
      assert.isNull(host.limitBytes)
      assert.isNull(allocations.workloadLimit.limitBytes)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )
})

describe("an unreadable slice", () => {
  it.effect("leaves a limit alone rather than misread it", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup()
      const higher = wanted + 64 * MEBIBYTE
      host.limitBytes = higher
      host.garbledState = " 0\n"
      yield* slice.reconcile()
      assert.strictEqual(host.limitBytes, higher)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )

  it.effect("reports no limit after a setup it undid and can't read", () =>
    Effect.gen(function* () {
      const { allocations, host, slice } = setup()
      host.kernelBytes = 1
      host.garbledState = "\n"
      host.readsBeforeGarbled = 1
      yield* slice.reconcile()
      assert.isNull(host.limitBytes)
      assert.isNull(allocations.workloadLimit.limitBytes)
    })
  )
})

describe("a limit that won't lift", () => {
  it.effect("is still reported when a Relay opts out", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup({
        workloadMemoryLimit: false,
      })
      host.limitBytes = wanted
      host.refusesClear = true
      yield* slice.reconcile()
      assert.strictEqual(allocations.workloadLimit.limitBytes, wanted)
    })
  )

  it.effect("is still reported after a failed first setup", () =>
    Effect.gen(function* () {
      const { allocations, host, slice, wanted } = setup()
      host.kernelBytes = 1
      host.refusesClear = true
      yield* slice.reconcile()
      assert.strictEqual(allocations.workloadLimit.limitBytes, wanted)
      assert.isUndefined(allocations.workloadSpec().cgroupParent)
    })
  )
})

describe("assigning memory", () => {
  const check = (memoryBytes: number, currentMemoryBytes: number | null) =>
    assertResourceLimitsFit({
      assignableMemoryBytes: 10,
      currentDiskBytes: null,
      currentMemoryBytes,
      limits: { ...NO_RESOURCE_LIMITS, memoryBytes },
      nodeDiskBytes: 0,
      others: [{ ...NO_RESOURCE_LIMITS, memoryBytes: 8 }],
    })

  it("refuses what doesn't fit beside the node's other limits", () => {
    assert.doesNotThrow(() => check(2, null))
    assert.throws(() => check(3, null), /assignable capacity/u)
  })

  it("lets an instance on a full node keep its limit, but not raise it", () => {
    assert.doesNotThrow(() => check(5, 5))
    assert.throws(() => check(6, 5), /assignable capacity/u)
  })
})
