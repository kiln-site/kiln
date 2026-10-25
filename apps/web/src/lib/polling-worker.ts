import { Clock, Effect, Fiber, Metric, Queue } from "effect"

import { promiseEffect } from "@/effect/promise"
import { forkAppWorker, reportAppError } from "@/effect/runtime"

const passes = Metric.counter("hearth.worker.passes", {
  description:
    "Passes a Hearth background worker made over its queue, by whether it found work",
  attributes: { unit: "{pass}" },
  incremental: true,
})

/** Hearth's workers that poll MySQL for due jobs. */
export type PollingWorkerName =
  | "Instances.postProvision"
  | "Notifications.push"
  | "ServerMigrations"
  | "TailscaleCleanup"

/**
 * What a pass found: due jobs it worked through, or none, with when the next
 * queued job is due (null when none is queued).
 */
export type WorkerPass =
  | { readonly outcome: "worked" }
  | { readonly outcome: "idle"; readonly nextAttemptAt: number | null }

// The quickest a worker looks again, as while it works through a backlog or
// its queue is failing; and the longest, for jobs queued without a wake, such
// as by a Hearth that stopped before its worker saw them.
const MIN_INTERVAL_MS = 2_000
const MAX_INTERVAL_MS = 30_000

interface PollingWorker {
  fiber: Fiber.Fiber<void> | null
  readonly wake: Queue.Queue<void>
}

// Global, so a dev reload's new code reaches the same wakes and replaces the
// old worker.
const state = globalThis as typeof globalThis & {
  kilnPollingWorkers?: Map<PollingWorkerName, PollingWorker>
}

function pollingWorker(name: PollingWorkerName): PollingWorker {
  state.kilnPollingWorkers ??= new Map()
  let worker = state.kilnPollingWorkers.get(name)
  if (!worker) {
    // One pending wake is enough: the next pass sees every job queued so far.
    worker = { fiber: null, wake: Effect.runSync(Queue.dropping<void>(1)) }
    state.kilnPollingWorkers.set(name, worker)
  }
  return worker
}

/**
 * Has a worker look for due jobs now, as after queueing one, rather than at
 * its next scheduled pass. Call it once the job is committed.
 */
export function wakePollingWorker(name: PollingWorkerName): void {
  Queue.offerUnsafe(pollingWorker(name).wake, undefined)
}

/**
 * Runs `pass` whenever a job is queued or due, for a worker that polls MySQL
 * for due jobs. Between jobs it sleeps until the next one is due, or until
 * woken, looking again at least every 30 seconds. The pass checks for work
 * untraced and traces only a pass that has some, so an idle Hearth exports
 * no traces. Every pass is counted instead. A failing pass is reported once,
 * until one succeeds. Starting a worker again replaces the running one.
 */
export function startPollingWorker(
  name: PollingWorkerName,
  pass: () => Promise<WorkerPass>
): void {
  const worker = pollingWorker(name)
  const previous = worker.fiber
  let lastFailure: string | null = null
  const count = (outcome: WorkerPass["outcome"] | "failed") =>
    Metric.update(
      Metric.withAttributes(passes, { "hearth.worker": name, outcome }),
      1
    )
  const runPass = promiseEffect(pass).pipe(
    Effect.tap((result) => {
      lastFailure = null
      return count(result.outcome)
    }),
    Effect.catch((cause) => {
      const message = cause instanceof Error ? cause.message : String(cause)
      // A pass fails again every few seconds while MySQL is down; only a new
      // failure reaches telemetry.
      if (message !== lastFailure) {
        lastFailure = message
        console.warn(`[Kiln] ${name} pass failed:`, cause)
        reportAppError(cause, { operation: `${name}.poll` })
      }
      return count("failed").pipe(Effect.as(null))
    })
  )
  const loop = Effect.gen(function* () {
    while (true) {
      // Wakes from before this pass are answered by it; one during it
      // starts the next.
      yield* Queue.clear(worker.wake)
      // A pass runs to its end, so a replacement or shutdown never overlaps
      // one still working through jobs; only the wait between passes is cut
      // short.
      const result = yield* Effect.uninterruptible(runPass)
      const now = yield* Clock.currentTimeMillis
      const delay =
        result?.outcome === "idle"
          ? Math.min(
              MAX_INTERVAL_MS,
              Math.max(
                MIN_INTERVAL_MS,
                (result.nextAttemptAt ?? Infinity) - now
              )
            )
          : MIN_INTERVAL_MS
      yield* Effect.raceFirst(Effect.sleep(delay), Queue.take(worker.wake))
    }
  })
  // Waiting out the replaced worker can't be cut short either, so a chain of
  // restarts still finishes one pass before the next begins.
  worker.fiber = forkAppWorker(
    (previous
      ? Effect.uninterruptible(Fiber.interrupt(previous))
      : Effect.void
    ).pipe(Effect.andThen(loop))
  )
}

/**
 * Stops every worker, as when Hearth shuts down, letting a running pass
 * finish for up to 5 seconds of Hearth's 10-second shutdown.
 */
export function stopPollingWorkers(): Promise<void> {
  const fibers = [...(state.kilnPollingWorkers?.values() ?? [])].flatMap(
    (worker) => {
      const fiber = worker.fiber
      worker.fiber = null
      return fiber ? [fiber] : []
    }
  )
  return Effect.runPromise(
    Fiber.interruptAll(fibers).pipe(
      Effect.timeoutOption("5 seconds"),
      Effect.asVoid
    )
  )
}
