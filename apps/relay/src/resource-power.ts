/**
 * One power path for game servers, Apps, and databases.
 *
 * Every kind starts, stops, restarts, and kills its containers the same way
 * (`containerPower`), and every power change is one of `ResourcePower`'s
 * operations: a person's change moves the resource's power intent, and a
 * schedule's step runs only while nobody's has since its occurrence began.
 * What a kind does around Docker stays its own: a game server's stop
 * command and recreation, a database's readiness wait, and an App's many
 * containers.
 */
import {
  relayAppActionSchema,
  relayDatabaseActionSchema,
  relayInstanceActionSchema,
} from "@workspace/contracts"
import { Effect, Predicate } from "effect"
import { z } from "zod"

import type { DockerEngine } from "./docker-engine.js"
import type { DockerEngineError } from "./effect/errors.js"
import type { LaneLock, OperationLanes } from "./operation-lanes.js"
import {
  resourceLaneKey,
  resourcePowerLocks,
  type PowerResourceKind,
} from "./operation-plans.js"
import {
  controlOperation,
  type ControlOperations,
} from "./operations/control.js"
import {
  operation,
  runOperation,
  type RelayOperation,
} from "./operations/operation.js"
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

/** A power action, as an operation's input. */
export interface PowerInput {
  /** The resource's full ID; a game server's may be a short ID or name. */
  readonly id: string
  readonly action: PowerAction
}

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

export class ResourcePower<Results extends Record<PowerResourceKind, unknown>> {
  /**
   * Power actions on each kind (`instance.action`, `app.action`,
   * `database.action`), whoever asks: Hearth's requests and schedules'
   * power steps.
   */
  readonly operations: {
    readonly [Kind in PowerResourceKind]: RelayOperation<
      PowerInput,
      Results[Kind],
      Error,
      never
    >
  }
  readonly #adapters: PowerAdapters<Results>
  readonly #intents = new PowerIntents()
  readonly #lanes: OperationLanes
  readonly #locks: PowerLocks
  readonly #replacements: ResourceReplacements
  readonly #resolveInstance: (reference: string) => string | Promise<string>

  constructor(options: {
    readonly adapters: PowerAdapters<Results>
    readonly lanes: OperationLanes
    /**
     * Replacements the lanes don't see, such as an App's deployment, which
     * swaps its containers in its lifecycle lane.
     */
    readonly replacements?: ResourceReplacements
    /**
     * The locks a power action takes, by full ID: an App's also hold the
     * volumes it mounts.
     */
    readonly locks?: PowerLocks
    /** A game server's full ID from its short ID or name. */
    readonly resolveInstance?: (reference: string) => string | Promise<string>
  }) {
    this.#adapters = options.adapters
    this.#lanes = options.lanes
    this.#locks = options.locks ?? resourcePowerLocks
    this.#replacements = options.replacements ?? {}
    this.#resolveInstance = options.resolveInstance ?? ((id) => id)
    this.operations = {
      app: this.#operation("app", "app.action"),
      database: this.#operation("database", "database.action"),
      instance: this.#operation("instance", "instance.action"),
    }
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
   * A schedule's power step: its kind's operation, run for the schedule. It
   * fails with a superseded `LaneRejectedError` if the intent has moved
   * from `intent` by the time its turn comes.
   */
  scheduled(
    kind: PowerResourceKind,
    id: string,
    action: PowerAction,
    intent: string
  ): Promise<void> {
    const definition: RelayOperation<PowerInput, unknown, Error, never> =
      this.operations[kind]
    return Effect.runPromise(
      runOperation(
        this.#lanes,
        definition,
        { action, id },
        { kind: "schedule", powerIntent: intent }
      ).pipe(Effect.asVoid)
    )
  }

  // A power action on `kind`. Anyone's but a schedule's moves the intent,
  // so a schedule's pending steps give way to it; a schedule's own runs
  // only while the intent its occurrence noted holds, and moves nothing, so
  // its later steps still run.
  #operation<Kind extends PowerResourceKind>(
    kind: Kind,
    name: string
  ): RelayOperation<PowerInput, Results[Kind], Error, never> {
    const resolve = (id: string) =>
      kind === "instance" ? this.#resolveInstance(id) : id
    return operation<PowerInput>()({
      name,
      locks: ({ input }) => {
        const id = resolve(input.id)
        return Predicate.isPromise(id)
          ? id.then((resolved) => this.#locks(kind, resolved, input.action))
          : this.#locks(kind, id, input.action)
      },
      precondition: ({ caller, input }) =>
        caller.kind !== "schedule" ||
        this.intent(kind, input.id) === caller.powerIntent,
      run: ({ caller, input }) =>
        Effect.annotateCurrentSpan({
          "relay.power.action": input.action,
          "relay.resource.id": input.id,
          "relay.resource.kind": kind,
        }).pipe(
          Effect.andThen(
            Effect.tryPromise({
              try: async () => {
                const id = await resolve(input.id)
                if (caller.kind !== "schedule") this.#intents.advance(kind, id)
                return this.#adapters[kind](id, input.action)
              },
              catch: (cause) =>
                cause instanceof Error
                  ? cause
                  : new Error("Power change failed"),
            })
          )
        ),
    })
  }
}

// A game server by full ID, short ID, or name.
const relayInstanceReferenceSchema = z.object({ instanceId: z.string().min(1) })

/** Hearth's power requests, as `power`'s operations (control-socket.ts). */
export function powerControlOperations(
  power: ResourcePower<Record<PowerResourceKind, unknown>>
): ControlOperations {
  return {
    "app.action": controlOperation(power.operations.app, ({ payload }) => {
      const { action, appId } = relayAppActionSchema.parse(payload)
      return { action, id: appId }
    }),
    "database.action": controlOperation(
      power.operations.database,
      ({ payload }) => {
        const { action, databaseId } = relayDatabaseActionSchema.parse(payload)
        return { action, id: databaseId }
      }
    ),
    "instance.action": controlOperation(
      power.operations.instance,
      ({ payload }) => ({
        action: relayInstanceActionSchema.parse(payload).action,
        id: relayInstanceReferenceSchema.parse(payload).instanceId,
      })
    ),
  }
}
