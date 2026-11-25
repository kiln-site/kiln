import type { ChildProcess } from "node:child_process"
import { EventEmitter } from "node:events"
import { relative, resolve } from "node:path"
import { PassThrough } from "node:stream"

import { Effect, Fiber } from "effect"

import type { RelayConfig } from "../config.js"
import { DockerExecProcess, type DockerEngine } from "../docker-engine.js"
import { promiseEffect } from "../effect/promise.js"
import type { ResticSpawn } from "../restic.js"
import {
  helperBody,
  helperName,
  helpersInDevelopment,
  relayContainer,
  type TarSource,
} from "./tar-archives.js"

// restic takes its lock off the repository when it's asked to stop.
const STOP_SECONDS = 4

/**
 * Runs restic in a helper that mounts a volume, as root, so it reads and
 * writes every file's owner, mode, extended attributes and links. It's the
 * Relay's own image and restic, with no more of the Relay than the repository
 * needs: its folder here, or the Relay's network for the bridge to a bucket,
 * and the folder restic keeps its cache in.
 *
 * It stands in for a process of the Relay's own, so restic's output, its
 * failures and cancelling it are the same.
 */
export function resticHelperSpawn(options: {
  readonly config: RelayConfig
  readonly engine: DockerEngine
  /** The Relay's data directory as Docker's host sees it. */
  readonly hostDataDirectory: () => Promise<string>
  readonly readOnly: boolean
  readonly source: TarSource
}): ResticSpawn {
  const { config, engine } = options
  return (command, args, { cwd, env }) => {
    const child = new HelperProcess()
    const run = Effect.gen(function* () {
      const relay = yield* promiseEffect(() => relayContainer(config, engine))
      const host = yield* promiseEffect(options.hostDataDirectory)
      const repository = env.RESTIC_REPOSITORY ?? ""
      const local = repository.startsWith("/")
      // Cancelled while Docker was still being asked.
      if (child.killed) return 1
      const folders = [
        ...(local ? [repository] : []),
        ...(env.RESTIC_CACHE_DIR ? [env.RESTIC_CACHE_DIR] : []),
      ]
      const created = yield* engine.createContainer(
        helperName(config),
        helperBody(config, relay, options.source, {
          binds: folders.map((path) => ({
            source: resolve(host, relative(config.dataDirectory, path)),
            target: path,
          })),
          cmd: args,
          development: helpersInDevelopment(),
          entrypoint: command,
          env,
          memoryBytes: null,
          networkMode: local ? "none" : `container:${relay.Id}`,
          readOnly: options.readOnly,
          workingDirectory: cwd ?? "/",
        })
      )
      return yield* Effect.gen(function* () {
        const exited = yield* Effect.forkChild(
          engine.waitContainer(created.Id, "next-exit")
        )
        const output = new DockerExecProcess(
          yield* engine.attachContainer(created.Id),
          false,
          Fiber.join(exited),
          "restic"
        )
        output.stdout.pipe(child.stdout)
        output.stderr.pipe(child.stderr)
        if (child.killed) return 1
        yield* engine.startContainer(created.Id)
        yield* child.started(
          engine
            .stopContainer(created.Id, { seconds: STOP_SECONDS })
            .pipe(Effect.ignore)
        )
        return yield* output.exitCode
      }).pipe(
        Effect.ensuring(
          engine
            .removeContainer(created.Id, { force: true })
            .pipe(Effect.ignore)
        )
      )
    })
    Effect.runFork(
      run.pipe(
        Effect.match({
          onFailure: (cause) => child.emit("error", cause),
          onSuccess: (exitCode) => child.emit("close", exitCode),
        }),
        Effect.ensuring(
          Effect.sync(() => {
            child.stdout.end()
            child.stderr.end()
          })
        )
      )
    )
    return child as unknown as ChildProcess
  }
}

class HelperProcess extends EventEmitter {
  readonly stderr = new PassThrough()
  readonly stdin = null
  readonly stdout = new PassThrough()
  killed = false
  #stop: Effect.Effect<void> | null = null

  started(stop: Effect.Effect<void>): Effect.Effect<void> {
    this.#stop = stop
    return this.killed ? stop : Effect.void
  }

  kill(): boolean {
    this.killed = true
    if (this.#stop) Effect.runFork(this.#stop)
    return true
  }
}
