/**
 * Removes what Kiln leaves on Docker once it's done with it. Work that
 * replaces a container removes the old one itself; a removal Docker refuses
 * is kept in Relay's state and tried again by each pass here, in its owner's
 * lane, so a failure never leaves a container behind for good. A pass also
 * removes what a finished Hearth or Relay update left: its stopped helper
 * and the old container it set aside, which the helper, running in its own
 * process, can't hand to Relay's state. See docs/relay-runtime.md.
 */
import { Clock, Effect, Metric } from "effect"

import type { RelayConfig } from "./config.js"
import { containerName, type DockerEngine } from "./docker-engine.js"
import type {
  RelayDockerCleanupOwner,
  RelayDockerCleanupRecord,
  RelayStateStore,
} from "./effect/state.js"
import {
  exclusive,
  laneKeys,
  LaneRejectedError,
  type LaneLock,
  type OperationLanes,
} from "./operation-lanes.js"
import {
  appLifecycleLocks,
  databaseLifecycleLocks,
  instanceLifecycleLocks,
} from "./operation-plans.js"
import {
  operation,
  runOperation,
  type RelayCaller,
} from "./operations/operation.js"
import { KILN_INSTALLATION_LABEL, kilnComponent } from "./update-container.js"

const UPDATE_HELPER_LABEL = "io.kiln.update-helper"
// What the update helper renames the container it replaces to, until the
// replacement is healthy (updater.ts).
const UPDATE_BACKUP_NAME = /^(.+)-kiln-backup-\d+$/u

const removed = Metric.counter("relay.docker.cleanup.removed", {
  description: "Containers Relay removed after the work that left them",
  attributes: { unit: "{container}" },
  incremental: true,
})

const refused = Metric.counter("relay.docker.cleanup.refused", {
  description: "Container removals Docker refused, to be tried again",
  attributes: { unit: "{container}" },
  incremental: true,
})

type RemovalKind = "leftover" | "update-backup" | "update-helper"

export interface DockerCleanupOptions {
  readonly config: Pick<RelayConfig, "installationId">
  readonly engine: DockerEngine
  readonly lanes: OperationLanes
  readonly state: RelayStateStore["Service"]
  /** Whether an update this Relay started is still under way. */
  readonly updating: () => Effect.Effect<boolean>
}

export class DockerCleanup {
  readonly #config: Pick<RelayConfig, "installationId">
  readonly #engine: DockerEngine
  readonly #lanes: OperationLanes
  readonly #state: RelayStateStore["Service"]
  readonly #updating: () => Effect.Effect<boolean>

  constructor(options: DockerCleanupOptions) {
    this.#config = options.config
    this.#engine = options.engine
    this.#lanes = options.lanes
    this.#state = options.state
    this.#updating = options.updating
  }

  /**
   * Removes a container Relay is done with, by its ID, never its name,
   * which a later container can take. One Docker refuses is kept and tried
   * again by the next pass; the caller's work carries on either way.
   */
  removeContainer(
    containerId: string,
    input: {
      readonly owner: RelayDockerCleanupOwner | null
      readonly reason: string
      /** Its anonymous volumes too, as `docker rm --volumes`. */
      readonly volumes?: boolean
    }
  ): Effect.Effect<void> {
    const state = this.#state
    const volumes = input.volumes ?? false
    return this.#remove(containerId, volumes).pipe(
      Effect.tap(() => count(removed, "leftover")),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* count(refused, "leftover")
          const now = yield* Clock.currentTimeMillis
          yield* state
            .recordDockerCleanup(
              {
                containerId,
                error: cause.message,
                owner: input.owner,
                reason: input.reason,
                volumes,
              },
              now
            )
            .pipe(Effect.ignore)
          yield* Effect.logWarning(
            "Docker didn't remove a container; Relay will try again",
            { containerId, reason: input.reason, error: cause.message }
          )
        })
      )
    )
  }

  /**
   * Removes what finished updates left, then tries each kept container
   * again in its owner's lane. Work in the way waits for the next pass.
   */
  pass(caller: RelayCaller): Effect.Effect<void> {
    const lanes = this.#lanes
    const state = this.#state
    const skipBusy = <A, E>(effect: Effect.Effect<A, E | LaneRejectedError>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchIf(
          (cause) => cause instanceof LaneRejectedError,
          () => Effect.void
        )
      )
    return Effect.gen({ self: this }, function* () {
      yield* skipBusy(
        runOperation(lanes, this.#sweepUpdates, undefined, caller)
      )
      const leftovers = yield* state.listDockerCleanups()
      for (const leftover of leftovers) {
        yield* skipBusy(
          runOperation(lanes, this.#retryRemoval, leftover, caller)
        )
      }
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Docker cleanup didn't finish", cause)
      )
    )
  }

  readonly #retryRemoval = operation<RelayDockerCleanupRecord>()({
    name: "relay.docker.cleanup.leftover",
    locks: ({ input }) => ownerLocks(input.owner),
    onlyIfFree: true,
    run: ({ input }) => {
      const state = this.#state
      return this.#remove(input.containerId, input.volumes).pipe(
        Effect.andThen(state.forgetDockerCleanup(input.containerId)),
        Effect.andThen(count(removed, "leftover")),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* count(refused, "leftover")
            const now = yield* Clock.currentTimeMillis
            yield* state.recordDockerCleanup(
              {
                containerId: input.containerId,
                error: cause.message,
                owner: input.owner,
                reason: input.reason,
                volumes: input.volumes,
              },
              now
            )
            // Once a day for one that keeps failing, at hourly passes.
            if (input.failures % 24 === 0) {
              yield* Effect.logWarning(
                "Docker still won't remove a leftover container",
                {
                  containerId: input.containerId,
                  error: cause.message,
                  failures: input.failures + 1,
                  reason: input.reason,
                }
              )
            }
          })
        ),
        Effect.ignore
      )
    },
  })

  // The helper of a finished update, and the container it set aside once
  // the replacement under its name runs. Nothing while any update runs:
  // a running helper may still roll back to the container it set aside.
  readonly #sweepUpdates = operation<void>()({
    name: "relay.docker.cleanup.updates",
    locks: () => [exclusive(laneKeys.dockerCleanup)],
    onlyIfFree: true,
    run: () =>
      Effect.gen({ self: this }, function* () {
        if (yield* this.#updating()) return
        const containers = yield* this.#engine.listContainers({ all: true })
        const helpers = containers.filter(
          (container) => container.Labels?.[UPDATE_HELPER_LABEL] === "true"
        )
        if (helpers.some((helper) => helper.State === "running")) return
        const byName = new Map(
          containers.map((container) => [containerName(container), container])
        )
        for (const helper of helpers) {
          yield* this.#removeSwept(helper.Id, "update-helper")
        }
        for (const container of containers) {
          if (container.State === "running") continue
          const original = UPDATE_BACKUP_NAME.exec(
            containerName(container)
          )?.[1]
          if (!original || byName.get(original)?.State !== "running") continue
          const labels = container.Labels ?? {}
          if (!kilnComponent(labels["io.kiln.component"])) continue
          const installation = labels[KILN_INSTALLATION_LABEL]
          if (installation && installation !== this.#config.installationId) {
            continue
          }
          yield* this.#removeSwept(container.Id, "update-backup")
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Relay couldn't look for update leftovers", cause)
        )
      ),
  })

  #removeSwept(containerId: string, kind: RemovalKind): Effect.Effect<void> {
    return this.#remove(containerId, false).pipe(
      Effect.andThen(count(removed, kind)),
      Effect.catch((cause) =>
        count(refused, kind).pipe(
          Effect.andThen(
            Effect.logWarning("Docker didn't remove an update leftover", {
              containerId,
              error: cause.message,
              kind,
            })
          )
        )
      )
    )
  }

  #remove(containerId: string, volumes: boolean) {
    return this.#engine.removeContainer(containerId, {
      force: true,
      timeout: 90_000,
      volumes,
    })
  }
}

// A leftover's removal waits for the owner's power changes, as replacing
// its container did; one with no owner waits only for other cleanup.
function ownerLocks(
  owner: RelayDockerCleanupOwner | null
): ReadonlyArray<LaneLock> {
  switch (owner?.kind) {
    case "app":
      return appLifecycleLocks(owner.id)
    case "database":
      return databaseLifecycleLocks(owner.id)
    case "instance":
      return instanceLifecycleLocks(owner.id)
    case undefined:
      return [exclusive(laneKeys.dockerCleanup)]
  }
}

function count(
  metric: Metric.Metric<number, unknown>,
  kind: RemovalKind
): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(metric, { "cleanup.kind": kind }),
    1
  )
}
