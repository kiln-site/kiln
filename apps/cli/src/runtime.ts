import { Effect } from "effect"

import type { CliCommandError } from "./errors.js"
import { reportErrorCauseEffect } from "./output.js"

export function runCliProgram(program: Effect.Effect<void, CliCommandError>) {
  const fiber = Effect.runFork(
    program.pipe(Effect.catchCause(reportErrorCauseEffect))
  )
  let active = true
  const interrupt = () => {
    if (!active) return
    active = false
    process.exitCode = 130
    fiber.interruptUnsafe()
  }
  const cleanup = () => {
    active = false
    process.off("SIGINT", interrupt)
    process.off("SIGTERM", interrupt)
  }

  process.on("SIGINT", interrupt)
  process.on("SIGTERM", interrupt)
  fiber.addObserver(cleanup)
}
