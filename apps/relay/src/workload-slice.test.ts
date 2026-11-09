import { assert, describe, it } from "@effect/vitest"
import { Effect } from "effect"

import { NO_RESOURCE_LIMITS } from "@workspace/contracts"

import type { DockerEngine } from "./docker-engine.js"
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

  runOnce(script: string) {
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
      if (this.garbledState !== null) {
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

  startContainer = () => Effect.void
}

function setup(options: { readonly workloadMemoryLimit?: boolean } = {}) {
  const host = new Host()
  const engine = new Engine()
  const allocations = new ResourceAllocations({
    mode: "node",
    reservedMemoryBytes: 1024 ** 3,
  })
  allocations.register("server", async () => [
    { id: "other", limits: { ...NO_RESOURCE_LIMITS, memoryBytes: 0 } },
  ])
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

  it.effect(
    "leaves an unreadable slice's limit alone rather than misread it",
    () =>
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
