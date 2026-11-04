/**
 * The ceiling on what the node's game servers, Apps, and databases use
 * together: a systemd slice they all run under, which leaves the rest of the
 * node to Kiln and the OS. The slice costs nothing itself and each workload
 * keeps its own limit; the ceiling is what holds workloads with no limit, and
 * too many at once.
 *
 * Docker can name a parent cgroup for a container but can't size one, so the
 * Relay sets the slice up on the host, each time it starts. Nothing is
 * placed in the slice until the kernel is seen enforcing it, and a host that
 * can't do this runs as it did before. See docs/relay-runtime.md.
 */
import { totalmem } from "node:os"

import { Duration, Effect, Exit } from "effect"

import type { RelayConfig } from "./config.js"
import { createContainer, WORKLOAD_SLICE_LABEL } from "./docker-container-spec.js"
import type { DockerEngine, DockerEngineError } from "./docker-engine.js"
import { HOST_SHELL_IMAGE, type HostShell } from "./host-shell.js"
import { exclusive, laneKeys, type OperationLanes } from "./operation-lanes.js"
import { operation, runOperation } from "./operations/operation.js"
import type { ResourceAllocations } from "./resource-limits.js"

// No hyphen: systemd reads one as nesting, which would put the slice under
// another and leave its CPU weight with nothing to weigh against.
const WORKLOAD_SLICE = "kilnworkloads.slice"
const CGROUP_ROOT = "/sys/fs/cgroup"
// Against the 100 of everything outside the slice, when CPUs are contended.
const WORKLOAD_CPU_WEIGHT = 50
const DEFAULT_CPU_WEIGHT = 100
const PROBE_NAME = "kiln-workload-slice-probe"
const MEBIBYTE = 1024 ** 2
const RECONCILE_TIMEOUT = Duration.minutes(2)

type Host = Pick<HostShell, "enabled" | "runOnce">
type SliceConfig = Pick<RelayConfig, "resourceNamespace" | "workloadMemoryLimit">

const STATE_SCRIPT = `if [ ! -d /run/systemd/system ] || ! command -v systemctl >/dev/null 2>&1; then
  echo unsupported
  exit 0
fi
set -e
group=$(systemctl show ${WORKLOAD_SLICE} -p ControlGroup --value)
limit=$(systemctl show ${WORKLOAD_SLICE} -p MemoryMax --value)
populated=0
if [ -n "$group" ] && grep -q '^populated 1$' "${CGROUP_ROOT}$group/cgroup.events" 2>/dev/null; then
  populated=1
fi
echo "$limit $populated"`

// `revert` alone forgets the settings but leaves the kernel enforcing them,
// so what counts is that the kernel lets go. A slice with nothing in it has
// no cgroup to ask.
const CLEAR_SCRIPT = `set -e
systemctl set-property ${WORKLOAD_SLICE} MemoryMax=infinity MemorySwapMax=infinity CPUWeight=${DEFAULT_CPU_WEIGHT}
systemctl revert ${WORKLOAD_SLICE} >/dev/null
group=$(systemctl show ${WORKLOAD_SLICE} -p ControlGroup --value)
limit="${CGROUP_ROOT}$group/memory.max"
if [ -n "$group" ] && [ -r "$limit" ] && [ "$(cat "$limit")" != max ]; then
  echo "The kernel still enforces the workload memory limit" >&2
  exit 1
fi`

const applyScript = (limitBytes: number) =>
  `systemctl set-property ${WORKLOAD_SLICE} MemoryMax=${limitBytes} MemorySwapMax=0 CPUWeight=${WORKLOAD_CPU_WEIGHT}`

// What the kernel enforces, rather than what systemd was told, with the
// probe's cgroup in the slice. A cgroup file always stats as empty, so its
// contents are what show a process there.
const verifyScript = (limitBytes: number, containerId: string) => `group=$(systemctl show ${WORKLOAD_SLICE} -p ControlGroup --value)
directory="${CGROUP_ROOT}$group"
if [ "$(cat "$directory/memory.max")" = "${limitBytes}" ] && grep -q . "$directory/docker-${containerId}.scope/cgroup.procs"; then
  echo enforced
fi`

interface SliceState {
  /** The limit set on it, or null with none. */
  readonly limitBytes: number | null
  /** Whether anything runs in it. */
  readonly populated: boolean
}

// Null on a host without systemd. Anything but the exact answer fails: a
// misread limit is one the Relay could go on to lower.
function parseState(output: string): Effect.Effect<SliceState | null, Error> {
  const answer = output.trim()
  if (answer === "unsupported") return Effect.succeed(null)
  const match = /^(infinity|\d+) ([01])$/u.exec(answer)
  const limitBytes =
    match?.[1] === "infinity" ? null : Number(match?.[1] ?? Number.NaN)
  if (!match || (limitBytes !== null && !Number.isSafeInteger(limitBytes))) {
    return Effect.fail(
      new Error(`Couldn't read the workload slice's state: ${answer}`)
    )
  }
  return Effect.succeed({ limitBytes, populated: match[2] === "1" })
}

// Whole mebibytes, so the kernel holds the value exactly at any page size.
const wholeMebibytes = (bytes: number) =>
  Math.floor(bytes / MEBIBYTE) * MEBIBYTE

// The same rounded up, for what mustn't be lowered.
const mebibytesAbove = (bytes: number) =>
  Math.ceil(bytes / MEBIBYTE) * MEBIBYTE

/** Why workloads can't run in a slice here, or null when they can. */
function unsupported(info: {
  readonly CgroupDriver?: string
  readonly CgroupVersion?: string
  readonly SecurityOptions?: ReadonlyArray<string> | null
}): string | null {
  if (info.CgroupDriver !== "systemd" || info.CgroupVersion !== "2") {
    return `Docker uses ${info.CgroupDriver ?? "an unknown"} cgroups, not systemd's on cgroup v2`
  }
  if (info.SecurityOptions?.some((option) => option.includes("rootless"))) {
    return "Docker runs rootless"
  }
  return null
}

export class WorkloadSlice {
  readonly #allocations: ResourceAllocations
  readonly #config: SliceConfig
  readonly #engine: DockerEngine
  readonly #host: Host
  readonly #lanes: OperationLanes
  readonly #reconcile = operation<void>()({
    name: "relay.workload-slice.reconcile",
    locks: () => [exclusive(laneKeys.allocations)],
    run: () =>
      this.#apply().pipe(
        Effect.timeoutOrElse({
          duration: RECONCILE_TIMEOUT,
          orElse: () =>
            Effect.logWarning(
              "Setting up the workload memory limit took too long"
            ),
        })
      ),
  })

  constructor(
    config: SliceConfig,
    engine: DockerEngine,
    host: Host,
    allocations: ResourceAllocations,
    lanes: OperationLanes
  ) {
    this.#allocations = allocations
    this.#config = config
    this.#engine = engine
    this.#host = host
    this.#lanes = lanes
  }

  /** Brings the slice in line with this Relay's settings, once at startup. */
  reconcile(): Effect.Effect<void> {
    if (!this.#host.enabled) {
      return Effect.logInfo(
        "No workload memory limit: host access is off on this Relay"
      )
    }
    return runOperation(this.#lanes, this.#reconcile, undefined, {
      kind: "worker",
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not set up the workload memory limit", cause)
      ),
      Effect.asVoid
    )
  }

  #apply(): Effect.Effect<void, unknown> {
    const host = this.#host
    const engine = this.#engine
    const config = this.#config
    const allocations = this.#allocations
    const place = this.#place.bind(this)
    const settle = this.#settle.bind(this)
    return Effect.gen(function* () {
      if (config.resourceNamespace) {
        yield* Effect.logInfo(
          "No workload memory limit: this Relay shares its Docker host"
        )
        return
      }
      const info = yield* engine.info({ timeout: 10_000 })
      const reason = unsupported(info)
      if (reason !== null && config.workloadMemoryLimit) {
        yield* Effect.logInfo(`No workload memory limit: ${reason}`)
        return
      }
      const state = yield* host
        .runOnce(STATE_SCRIPT)
        .pipe(Effect.flatMap(parseState))
      if (state === null) {
        yield* Effect.logInfo("No workload memory limit: no systemd on the host")
        return
      }
      allocations.setWorkloadLimit(null, state.limitBytes)
      if (!config.workloadMemoryLimit) {
        if (state.limitBytes !== null) {
          yield* host.runOnce(CLEAR_SCRIPT)
          allocations.setWorkloadLimit(null, null)
        }
        return
      }
      const assignable = allocations.assignableMemoryBytes
      if (assignable <= 0) {
        yield* Effect.logWarning(
          "No workload memory limit: the reserve leaves workloads nothing"
        )
        return
      }
      const others = yield* Effect.tryPromise(() =>
        allocations.others("", "")
      )
      const assigned = others.reduce(
        (total, limits) => total + (limits.memoryBytes ?? 0),
        0
      )
      const total = totalmem()
      // Never below what's already assigned: a node over its budget keeps
      // the capacity its limits promise until they come down.
      const wanted = wholeMebibytes(
        Math.min(total, Math.max(assignable, assigned))
      )
      // The Relay only ever sets a limit up or raises it. Lowering one under
      // workloads reclaims from them and can kill them, so that's left to
      // whoever runs the node. A first limit is as safe as the slice is empty:
      // nothing new is placed there until this confirms it, which leaves
      // only workloads placed before an opt-out, running or stopped.
      let limitBytes = wanted
      if (state.limitBytes !== null) {
        limitBytes = Math.max(wanted, mebibytesAbove(state.limitBytes))
      } else {
        const placed = yield* engine.listContainers({
          all: true,
          filters: { label: [WORKLOAD_SLICE_LABEL] },
        })
        if (state.populated || placed.length > 0) {
          limitBytes = mebibytesAbove(total)
        }
      }
      yield* place(limitBytes).pipe(
        // Whatever stopped it, timing out included, so a first setup that
        // can't be confirmed leaves nothing behind on the host. A working
        // limit stays: one failed check is no reason to drop it under running
        // workloads, though new ones stay out of it until it's confirmed.
        Effect.onExit((exit) =>
          Exit.isSuccess(exit) ? Effect.void : settle(state)
        ),
        Effect.catch((cause) =>
          Effect.logWarning(
            "Could not confirm the workload memory limit",
            cause
          )
        )
      )
    })
  }

  // Undoes a first setup, then reports the limit the host is left with, which
  // a failed check may have raised. One it can't read is reported as none:
  // better to show less protection than there is than more.
  #settle(previous: SliceState): Effect.Effect<void> {
    const host = this.#host
    const allocations = this.#allocations
    return Effect.gen(function* () {
      if (previous.limitBytes === null) {
        yield* host.runOnce(CLEAR_SCRIPT).pipe(
          Effect.catch((cause) =>
            Effect.logWarning(
              "Could not lift the workload memory limit",
              cause
            )
          )
        )
      }
      const state = yield* host
        .runOnce(STATE_SCRIPT)
        .pipe(Effect.flatMap(parseState))
      allocations.setWorkloadLimit(null, state?.limitBytes ?? null)
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning(
          "Could not read the workload memory limit",
          cause
        ).pipe(
          Effect.andThen(
            Effect.sync(() => allocations.setWorkloadLimit(null, null))
          )
        )
      )
    )
  }

  #place(limitBytes: number): Effect.Effect<void, Error | DockerEngineError> {
    // Placed in the slice only here, once the kernel is seen enforcing it.
    const host = this.#host
    const engine = this.#engine
    const allocations = this.#allocations
    return Effect.scoped(
      Effect.gen(function* () {
        yield* host.runOnce(applyScript(limitBytes))
        // One a crash left behind would stop this one being created.
        yield* engine
          .removeContainer(PROBE_NAME, { force: true })
          .pipe(Effect.ignore)
        const probe = yield* Effect.acquireRelease(
          createContainer(engine, {
            capDrop: ["ALL"],
            cgroupParent: WORKLOAD_SLICE,
            command: ["sleep", "60"],
            image: HOST_SHELL_IMAGE,
            labels: { "kiln.relay.owned": "true" },
            memory: "16m",
            memorySwap: "16m",
            name: PROBE_NAME,
            network: "none",
          }),
          (created) =>
            engine
              .removeContainer(created.Id, { force: true })
              .pipe(Effect.ignore)
        )
        yield* engine.startContainer(probe.Id)
        const verdict = yield* host.runOnce(verifyScript(limitBytes, probe.Id))
        if (verdict.trim() !== "enforced") {
          return yield* Effect.fail(
            new Error("The kernel isn't enforcing the workload memory limit")
          )
        }
        allocations.setWorkloadLimit(WORKLOAD_SLICE, limitBytes)
      })
    )
  }
}
