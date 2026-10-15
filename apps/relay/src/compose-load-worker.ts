import { parentPort, workerData } from "node:worker_threads"

import { Effect, Result } from "effect"

import type { ComposeLoadRequest, ComposeLoadResponse } from "./compose-load.js"
import { readComposeProject } from "./compose-project.js"

// Reads a Compose project off the Relay's thread (see compose-load.ts): a
// file that's slow or large to parse, expand, or interpolate stalls this
// thread, which the Relay stops at its limits, never its own.
const port = parentPort!
const send = (message: ComposeLoadResponse) => port.postMessage(message)
const request = workerData as ComposeLoadRequest

const loaded = await Effect.runPromise(
  Effect.result(
    Effect.tryPromise(() =>
      readComposeProject({
        ...request,
        onWarning: (message) => send({ message, type: "warning" }),
      })
    )
  )
)
if (Result.isSuccess(loaded)) send({ project: loaded.success, type: "loaded" })
else {
  const cause = loaded.failure.cause
  send({
    message: cause instanceof Error ? cause.message : String(cause),
    type: "failed",
  })
}
