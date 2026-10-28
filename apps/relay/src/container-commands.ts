/**
 * One-off commands in an App's service or a database's container.
 *
 * A command runs as `sh -c <command>` in a Docker exec, in its resource's
 * lifecycle lane (`containerCommandLocks`), so it waits for power changes and
 * deployments and they wait for it. It has `containerCommandTimeoutMs` to
 * exit, and the end of what it prints, stdout and stderr together, is kept
 * up to `containerCommandOutputBytes`.
 *
 * A command fails without running when its container is missing, stopped,
 * or replaced before Docker starts it, or has no `sh`. Once Docker may have
 * started it, its result is its exit code, or unknown when Kiln lost track
 * of it: it outlived its timeout, Docker's stream broke, or Docker didn't
 * report how it exited. Docker has no way to stop an exec, so one that
 * outlives its timeout may still be running. Nothing here retries a command.
 */
import { Effect, Schema } from "effect"

import { isDockerNotFound, type DockerEngine } from "./docker-engine.js"
import type { OperationLanes } from "./operation-lanes.js"
import { containerCommandLocks } from "./operation-plans.js"

/** How long a command may run before Kiln stops waiting for it. */
export const containerCommandTimeoutMs = 10 * 60_000
/** How much of the end of a command's output its result keeps. */
export const containerCommandOutputBytes = 4 * 1024

export type ContainerCommandTarget =
  | { readonly id: string; readonly kind: "database" }
  | { readonly id: string; readonly kind: "app"; readonly service: string }

/** Where commands find their containers, when their turn comes. */
export interface CommandContainers {
  readonly apps: {
    serviceContainer(
      appId: string,
      service: string
    ): Promise<{ readonly id: string; readonly running: boolean } | null>
  }
  readonly databases: {
    target(id: string): Promise<{
      readonly containerId: string | null
      readonly observedState: string
    }>
  }
}

export interface ContainerCommandResult {
  /** Null when Kiln lost track of the command. */
  readonly exitCode: number | null
  readonly output: string
  /** Whether the command printed more than `output` keeps. */
  readonly truncated: boolean
  /** Why Kiln doesn't know how the command went; null once it exited. */
  readonly unknown: string | null
}

/** The command didn't run. */
export class ContainerCommandError extends Schema.TaggedError<ContainerCommandError>()(
  "ContainerCommandError",
  { message: Schema.String }
) {}

export class ContainerCommands {
  readonly #containers: CommandContainers
  readonly #engine: DockerEngine
  readonly #lanes: OperationLanes

  constructor(
    options: CommandContainers & {
      readonly engine: DockerEngine
      readonly lanes: OperationLanes
    }
  ) {
    this.#containers = options
    this.#engine = options.engine
    this.#lanes = options.lanes
  }

  /**
   * Runs `command` in its turn. Rejects when it didn't run, with a
   * `LaneRejectedError` when the lanes withdrew it, and otherwise answers
   * with how it went.
   */
  run(
    target: ContainerCommandTarget,
    command: string
  ): Promise<ContainerCommandResult> {
    const containers = this.#containers
    const resolve = async (): Promise<{
      readonly id: string
      readonly running: boolean
    } | null> => {
      if (target.kind === "app") {
        return containers.apps.serviceContainer(target.id, target.service)
      }
      const database = await containers.databases.target(target.id)
      return database.containerId
        ? {
            id: database.containerId,
            running: /^(?:running|starting)$/u.test(database.observedState),
          }
        : null
    }
    const engine = this.#engine
    const work = Effect.gen(function* () {
      const container = yield* Effect.tryPromise({
        try: resolve,
        catch: (cause) =>
          new ContainerCommandError({
            message: cause instanceof Error ? cause.message : "Not found",
          }),
      })
      if (!container) {
        return yield* new ContainerCommandError({
          message:
            target.kind === "app"
              ? `${target.service} has no container; deploy the App first`
              : "The database has no container",
        })
      }
      if (!container.running) {
        return yield* new ContainerCommandError({
          message: `${targetName(target)} isn't running`,
        })
      }
      return yield* execute(engine, container.id, command, targetName(target))
    })
    return Effect.runPromise(
      this.#lanes
        .run(
          {
            label: `${target.kind}.command`,
            locks: containerCommandLocks(target.kind, target.id),
          },
          work
        )
        .pipe(
          Effect.withSpan("relay.containers.command", {
            attributes: {
              "relay.resource.id": target.id,
              "relay.resource.kind": target.kind,
              ...(target.kind === "app" && {
                "relay.app.service": target.service,
              }),
            },
          })
        )
    )
  }
}

function execute(
  engine: DockerEngine,
  containerId: string,
  command: string,
  name: string
): Effect.Effect<ContainerCommandResult, ContainerCommandError> {
  return Effect.gen(function* () {
    // An exec Docker made but never started can't run, so a failure up to
    // the start's answer means the command didn't.
    const created = yield* engine
      .createExec(containerId, {
        AttachStderr: true,
        AttachStdin: false,
        AttachStdout: true,
        Cmd: ["sh", "-c", command],
        Tty: false,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ContainerCommandError({
              message: isDockerNotFound(cause)
                ? `${name}'s container was replaced; the command didn't run`
                : `The command didn't run: ${cause.reason}`,
            })
        )
      )
    const started = yield* Effect.result(
      engine.startExecProcess(created.Id, { program: "sh", stdin: false })
    )
    if (started._tag === "Failure") {
      if (started.failure.status !== undefined) {
        return yield* new ContainerCommandError({
          message: `The command didn't run: ${started.failure.reason}`,
        })
      }
      return lost(
        `Docker didn't answer as the command started (${started.failure.reason}), so it may have run`,
        new Tail(0)
      )
    }
    const process = started.success
    const output = new Tail(containerCommandOutputBytes)
    process.stdout.on("data", (chunk: Buffer) => output.add(chunk))
    process.stderr.on("data", (chunk: Buffer) => output.add(chunk))
    // Closing the connection, on a timeout or when the Relay stops waiting,
    // is all Docker allows; the process sees its output close.
    const exited = yield* Effect.result(
      process.exitCode.pipe(
        Effect.timeoutOrElse({
          duration: containerCommandTimeoutMs,
          orElse: () => Effect.succeed(null),
        }),
        Effect.ensuring(Effect.sync(() => process.kill()))
      )
    )
    if (exited._tag === "Failure") {
      return lost(
        `Kiln lost track of the command (${exited.failure.reason}), so it may still be running`,
        output
      )
    }
    if (exited.success === null) {
      return lost(
        `The command didn't finish within ${containerCommandTimeoutMs / 60_000} minutes and may still be running`,
        output
      )
    }
    const exitCode = exited.success
    // Docker reports an exec it couldn't start, such as one without a
    // shell, with no process and the shell's code for it.
    if (exitCode === 126 || exitCode === 127) {
      const exec = yield* Effect.result(engine.inspectExec(created.Id))
      if (exec._tag === "Success" && exec.success.Pid === 0) {
        return yield* new ContainerCommandError({
          message:
            exitCode === 127
              ? `${name}'s container has no sh to run the command`
              : `Docker couldn't start sh in ${name}'s container`,
        })
      }
    }
    return { exitCode, unknown: null, ...output.read() }
  })
}

function lost(reason: string, output: Tail): ContainerCommandResult {
  return { exitCode: null, unknown: reason, ...output.read() }
}

function targetName(target: ContainerCommandTarget): string {
  return target.kind === "app" ? target.service : "The database"
}

/** The last `limit` bytes of what a process printed. */
class Tail {
  #chunks: Array<Buffer> = []
  #kept = 0
  #dropped = false

  constructor(readonly limit: number) {}

  add(chunk: Buffer): void {
    this.#chunks.push(chunk)
    this.#kept += chunk.length
    while (this.#kept > this.limit) {
      const first = this.#chunks[0]!
      const excess = this.#kept - this.limit
      this.#dropped = true
      if (first.length <= excess) {
        this.#chunks.shift()
        this.#kept -= first.length
      } else {
        this.#chunks[0] = first.subarray(excess)
        this.#kept -= excess
      }
    }
  }

  read(): { readonly output: string; readonly truncated: boolean } {
    const text = Buffer.concat(this.#chunks).toString("utf8")
    // The cut can land inside a character.
    return {
      output: this.#dropped ? text.replace(/^�+/u, "") : text,
      truncated: this.#dropped,
    }
  }
}
