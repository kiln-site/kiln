import type { RelaySnapshot } from "@workspace/contracts"
import { Effect, Fiber } from "effect"

export interface RelaySnapshotSample {
  readonly sequence: number
  readonly snapshot: RelaySnapshot
}

type SnapshotListener = (sample: RelaySnapshotSample) => void

const sampleIntervalMs = 2_000

export class RelaySnapshotHub {
  readonly #listeners = new Set<SnapshotListener>()
  readonly #load: () => Promise<RelaySnapshot>
  #closed = false
  #last: (RelaySnapshotSample & { sampledAt: number }) | null = null
  #sampling: Fiber.Fiber<RelaySnapshotSample, Error> | null = null
  #scheduleFiber: Fiber.Fiber<void, never> | null = null
  #sequence = 0

  constructor(load: () => Promise<RelaySnapshot>) {
    this.#load = load
  }

  read(): Promise<RelaySnapshot> {
    if (this.#last && Date.now() - this.#last.sampledAt < sampleIntervalMs) {
      return Promise.resolve(this.#last.snapshot)
    }
    return Effect.runPromise(
      this.#sampleEffect().pipe(Effect.map(({ snapshot }) => snapshot))
    )
  }

  refresh(): Promise<RelaySnapshot> {
    const waitForSampling = this.#sampling
      ? Fiber.await(this.#sampling)
      : Effect.void
    return Effect.runPromise(
      waitForSampling.pipe(
        Effect.andThen(
          Effect.sync(() => {
            this.#cancelSchedule()
            this.#last = null
          })
        ),
        Effect.andThen(Effect.suspend(() => this.#sampleEffect())),
        Effect.map(({ snapshot }) => snapshot)
      )
    )
  }

  subscribe(listener: SnapshotListener, replay = true): () => void {
    if (this.#closed) throw new Error("Relay snapshot hub is closed")
    this.#listeners.add(listener)
    if (replay && this.#last) listener(this.#last)
    if (!this.#scheduleFiber && !this.#sampling) {
      if (this.#last) this.#schedule()
      else Effect.runFork(this.#sampleEffect().pipe(Effect.ignore))
    }
    return () => {
      this.#listeners.delete(listener)
      if (this.#listeners.size === 0) this.#cancelSchedule()
    }
  }

  close(): void {
    this.#closed = true
    this.#cancelSchedule()
    this.#sampling?.interruptUnsafe()
    this.#sampling = null
    this.#listeners.clear()
  }

  #sampleEffect(): Effect.Effect<RelaySnapshotSample, Error> {
    if (this.#closed) {
      return Effect.fail(new Error("Relay snapshot hub is closed"))
    }
    if (!this.#sampling) {
      let samplingFiber: Fiber.Fiber<RelaySnapshotSample, Error>
      samplingFiber = Effect.runFork(
        Effect.tryPromise({
          try: this.#load,
          catch: asError,
        }).pipe(
          Effect.map((snapshot) => {
            const sample = {
              sampledAt: Date.now(),
              sequence: ++this.#sequence,
              snapshot,
            }
            this.#last = sample
            for (const listener of this.#listeners) {
              Effect.runSync(
                Effect.sync(() => listener(sample)).pipe(
                  Effect.catchCause(() => Effect.void)
                )
              )
            }
            return sample
          }),
          Effect.ensuring(
            Effect.sync(() => {
              if (this.#sampling === samplingFiber) this.#sampling = null
              if (this.#listeners.size > 0) this.#schedule()
            })
          )
        )
      )
      this.#sampling = samplingFiber
    }
    return Fiber.join(this.#sampling)
  }

  #schedule(): void {
    if (this.#closed || this.#listeners.size === 0 || this.#scheduleFiber) {
      return
    }
    let scheduleFiber: Fiber.Fiber<void, never>
    scheduleFiber = Effect.runFork(
      Effect.sleep(sampleIntervalMs).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            if (this.#scheduleFiber === scheduleFiber) {
              this.#scheduleFiber = null
            }
          })
        ),
        Effect.andThen(Effect.suspend(() => this.#sampleEffect())),
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            if (this.#scheduleFiber === scheduleFiber) {
              this.#scheduleFiber = null
            }
          })
        )
      )
    )
    this.#scheduleFiber = scheduleFiber
  }

  #cancelSchedule(): void {
    this.#scheduleFiber?.interruptUnsafe()
    this.#scheduleFiber = null
  }
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause))
}
