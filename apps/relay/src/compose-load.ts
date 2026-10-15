/**
 * Loads a Compose project (see `./compose-project.js`) in a worker thread,
 * as `docker compose config` once ran in a process of its own: parsing the
 * YAML, expanding aliases and merges, reading `.env` and env files,
 * interpolating, and normalizing never stall the Relay's event loop, and a
 * file too large or complex to load is stopped at the worker's memory,
 * stack, and time limits. Only the normalized project comes back.
 */
import { fileURLToPath } from "node:url"
import { Worker } from "node:worker_threads"

import { Effect } from "effect"

import type { ComposeLoadOptions, ComposeProject } from "./compose-project.js"

// What a load may use: real Compose files take a few megabytes and
// milliseconds.
const MAX_OLD_GENERATION_MB = 256
const MAX_YOUNG_GENERATION_MB = 32
const STACK_MB = 4

/** What the worker is given: the load's options, but its callback. */
export type ComposeLoadRequest = Omit<ComposeLoadOptions, "onWarning">

export type ComposeLoadResponse =
  | { readonly type: "warning"; readonly message: string }
  | { readonly type: "loaded"; readonly project: ComposeProject }
  | { readonly type: "failed"; readonly message: string }

/**
 * Loads the project, failing with the loader's error, or, past a limit
 * (`timeoutMs`, or the worker's memory or stack), with one naming it. The
 * worker is terminated when the load ends, and when it's interrupted.
 */
export function loadComposeProject(
  options: ComposeLoadOptions,
  limits: { readonly timeoutMs: number }
): Effect.Effect<ComposeProject, Error> {
  return Effect.callback<ComposeProject, Error>((resume) => {
    const { onWarning, ...request } = options
    const development = import.meta.url.endsWith(".ts")
    const worker = new Worker(
      fileURLToPath(
        new URL(
          development ? "./compose-load-worker.ts" : "./compose-load-worker.mjs",
          import.meta.url
        )
      ),
      {
        // Development loads tsx so the TypeScript entry also runs under tests.
        execArgv: development ? ["--import", "tsx"] : [],
        resourceLimits: {
          maxOldGenerationSizeMb: MAX_OLD_GENERATION_MB,
          maxYoungGenerationSizeMb: MAX_YOUNG_GENERATION_MB,
          stackSizeMb: STACK_MB,
        },
        workerData: request satisfies ComposeLoadRequest,
      }
    )
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (effect: Effect.Effect<ComposeProject, Error>) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      void worker.terminate()
      resume(effect)
    }
    const tooComplex = (limit: string) =>
      Effect.fail(
        new Error(`Compose file is too large or complex to load: ${limit}`)
      )
    timer = setTimeout(
      () =>
        settle(
          tooComplex(
            `loading it took longer than ${limits.timeoutMs / 1_000} s`
          )
        ),
      limits.timeoutMs
    )
    worker.on("message", (message: ComposeLoadResponse) => {
      if (message.type === "warning") onWarning(message.message)
      else if (message.type === "loaded") settle(Effect.succeed(message.project))
      else settle(Effect.fail(new Error(message.message)))
    })
    worker.on("error", (error: Error & { code?: string }) => {
      settle(
        error.code === "ERR_WORKER_OUT_OF_MEMORY"
          ? tooComplex(
              `loading it needed more than the ${MAX_OLD_GENERATION_MB} MB of memory it may use`
            )
          : error instanceof RangeError && /call stack/u.test(error.message)
            ? tooComplex(
                `it nests deeper than the ${STACK_MB} MB stack it may use allows`
              )
            : Effect.fail(
                new Error(`The Compose loader failed: ${error.message}`)
              )
      )
    })
    worker.on("exit", (code) =>
      settle(
        Effect.fail(
          new Error(`The Compose loader stopped unexpectedly (exit code ${code})`)
        )
      )
    )
    // Interrupted: the worker stops with the load.
    return Effect.promise(() => {
      settled = true
      clearTimeout(timer)
      return worker.terminate()
    }).pipe(Effect.asVoid)
  })
}
