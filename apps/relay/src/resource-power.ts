/**
 * One power path for game servers, Apps, and databases.
 *
 * Every kind starts, stops, restarts, and kills its containers the same way
 * (`containerPower`), and every power change goes through `ResourcePower`:
 * a person's change moves the resource's power intent, and a schedule's
 * step runs only while nobody's has since its occurrence began. What a kind
 * does around Docker stays its own: a game server's stop command and
 * recreation, a database's readiness wait, and an App's many containers.
 */
import { Effect } from "effect"

import type { DockerEngine } from "./docker-engine.js"
import type { DockerEngineError } from "./effect/errors.js"
import type { LaneLock, OperationLanes } from "./operation-lanes.js"
import {
  resourceLaneKey,
  resourcePowerLocks,
  type PowerResourceKind,
} from "./operation-plans.js"
import { PowerIntents } from "./power-intents.js"

export type PowerAction = "kill" | "restart" | "start" | "stop"

/** How long a stopping App or database container gets before it's killed. */
export const CONTAINER_STOP_SECONDS = 30

/**
 * Docker's part of a power action on one container. A stop gives the
 * process `stopSeconds` to exit before Docker kills it. Starting a running
 * container and stopping a stopped one succeed; killing a stopped one fails,
 * as Docker's own do.
 */
export function containerPower(
  engine: DockerEngine,
  container: string,
  action: PowerAction,
  stopSeconds = CONTAINER_STOP_SECONDS
): Effect.Effect<void, DockerEngineError> {
  const stopping = {
    seconds: stopSeconds,
    timeout: (stopSeconds + 15) * 1_000,
  }
  switch (action) {
    case "start":
      return engine.startContainer(container, { timeout: 120_000 })
    case "stop":
      return engine.stopContainer(container, stopping)
    // The stop, then however long the start takes.
    case "restart":
      return engine.restartContainer(container, {
        seconds: stopSeconds,
        timeout: (stopSeconds + 120) * 1_000,
      })
    case "kill":
      return engine.killContainer(container, { timeout: stopping.timeout })
  }
}

export type PowerLocks = (
  kind: PowerResourceKind,
  id: string,
  action: PowerAction
) => ReadonlyArray<LaneLock> | Promise<ReadonlyArray<LaneLock>>

/** How many times each kind's resources were replaced outside the lanes. */
export type ResourceReplacements = Partial<
  Record<PowerResourceKind, (id: string) => number>
>

/** What each kind does for a power action, and what it answers with. */
export type PowerAdapters<Results extends Record<PowerResourceKind, unknown>> =
  {
    readonly [Kind in PowerResourceKind]: (
      id: string,
      action: PowerAction
    ) => Promise<Results[Kind]>
  }

export class ResourcePower<
  Results extends Record<PowerResourceKind, unknown>,
> {
  readonly #adapters: PowerAdapters<Results>
  readonly #intents = new PowerIntents()
  readonly #lanes: OperationLanes
  readonly #locks: PowerLocks
  readonly #replacements: ResourceReplacements

  constructor(options: {
    readonly adapters: PowerAdapters<Results>
    readonly lanes: OperationLanes
    /**
     * Replacements the lanes don't see, such as an App's deployment, which
     * swaps its containers in its lifecycle lane.
     */
    readonly replacements?: ResourceReplacements
    /**
     * The locks a power action takes, as its control request's do: an
     * App's also hold the volumes it mounts.
     */
    readonly locks?: PowerLocks
  }) {
    this.#adapters = options.adapters
    this.#lanes = options.lanes
    this.#locks = options.locks ?? resourcePowerLocks
    this.#replacements = options.replacements ?? {}
  }

  /**
   * A token that changes whenever someone changes the resource's power or
   * anything replaces it, read when a schedule's occurrence begins.
   */
  intent(kind: PowerResourceKind, id: string): string {
    return [
      this.#intents.current(kind, id),
      this.#lanes.exclusiveGeneration(resourceLaneKey(kind, id)),
      this.#replacements[kind]?.(id) ?? 0,
    ].join(":")
  }

  /**
   * Notes a power change someone made without a power action, such as a
   * stop typed into a game server's console.
   */
  changed(kind: PowerResourceKind, id: string): void {
    this.#intents.advance(kind, id)
  }

  /**
   * A person's power change, run in the turn its request was admitted to
   * with `resourcePowerLocks`. A schedule's pending power steps give way.
   */
  requested<Kind extends PowerResourceKind>(
    kind: Kind,
    id: string,
    action: PowerAction
  ): Promise<Results[Kind]> {
    this.#intents.advance(kind, id)
    return this.#adapters[kind](id, action)
  }

  /**
   * A schedule's power step, in its own turn in the lanes. It runs only if
   * the intent hasn't moved from `intent` by the time its turn comes, and
   * otherwise fails with a superseded `LaneRejectedError`. It doesn't move
   * the intent itself, so the schedule's later steps still run.
   */
  scheduled(
    kind: PowerResourceKind,
    id: string,
    action: PowerAction,
    intent: string
  ): Promise<void> {
    const failure = (cause: unknown) =>
      cause instanceof Error ? cause : new Error("Power change failed")
    return Effect.runPromise(
      Effect.tryPromise({
        try: async () => this.#locks(kind, id, action),
        catch: failure,
      }).pipe(
        Effect.flatMap((locks) =>
          this.#lanes.run(
            {
              label: `schedule.${kind}.power`,
              locks,
              precondition: () => this.intent(kind, id) === intent,
            },
            Effect.tryPromise({
              try: () => this.#adapters[kind](id, action),
              catch: failure,
            })
          )
        ),
        Effect.asVoid,
        Effect.withSpan("relay.schedules.power", {
          attributes: {
            "relay.resource.id": id,
            "relay.resource.kind": kind,
            "relay.power.action": action,
          },
        })
      )
    )
  }
}
