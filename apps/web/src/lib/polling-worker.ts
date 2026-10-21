import { Effect, Metric } from "effect"

import { promiseEffect } from "@/effect/promise"
import { forkAppWorker, reportAppError } from "@/effect/runtime"

const passes = Metric.counter("hearth.worker.passes", {
  description:
    "Passes a Hearth background worker made over its queue, by whether it found work",
  attributes: { unit: "{pass}" },
  incremental: true,
})

/** Whether a pass found due jobs. */
export type WorkerPassOutcome = "idle" | "worked"

/**
 * Runs `pass` every `intervalMs`, forever, for a worker that polls MySQL for
 * due jobs. The pass checks for work untraced and traces only a pass that
 * has some, so an idle Hearth exports no traces. Every pass is counted
 * instead. A failing pass is reported once, until one succeeds.
 */
export function startPollingWorker(
  worker: string,
  pass: () => Promise<WorkerPassOutcome>,
  intervalMs: number
) {
  let lastFailure: string | null = null
  const count = (outcome: WorkerPassOutcome | "failed") =>
    Metric.update(
      Metric.withAttributes(passes, { "hearth.worker": worker, outcome }),
      1
    )
  return forkAppWorker(
    promiseEffect(pass).pipe(
      Effect.flatMap((outcome) => {
        lastFailure = null
        return count(outcome)
      }),
      Effect.catch((cause) => {
        const message = cause instanceof Error ? cause.message : String(cause)
        // A pass fails again every interval while MySQL is down; only a new
        // failure reaches telemetry.
        if (message !== lastFailure) {
          lastFailure = message
          console.warn(`[Kiln] ${worker} pass failed:`, cause)
          reportAppError(cause, { operation: `${worker}.poll` })
        }
        return count("failed")
      }),
      Effect.andThen(Effect.sleep(intervalMs)),
      Effect.forever
    )
  )
}
