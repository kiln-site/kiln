import { Clock, Effect, Semaphore } from "effect"

// Hearth runs as one process, so a change that mustn't interleave with
// another waits for it here, in memory (docs/hearth-operations.md). A
// development reload loads this module again in the same process, whose
// changes are still running; the process keeps one table.
const held = ((
  globalThis as typeof globalThis & {
    kilnSerializedKeys?: Map<
      string,
      { readonly semaphore: Semaphore.Semaphore; users: number }
    >
  }
).kilnSerializedKeys ??= new Map())

const withKey = <A, E, R>(key: string, effect: Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => {
      let entry = held.get(key)
      if (!entry) {
        entry = { semaphore: Semaphore.makeUnsafe(1), users: 0 }
        held.set(key, entry)
      }
      entry.users++
      return entry
    }),
    (entry) => Semaphore.withPermit(entry.semaphore)(effect),
    (entry) =>
      Effect.sync(() => {
        if (--entry.users === 0) held.delete(key)
      })
  )

/**
 * Runs `effect`, the change `kind`, once no other serialized change holds
 * any of `keys`, waiting its turn. Keys are taken in sorted order, so two
 * changes can't wait on each other. A caller that gives up while it waits
 * withdraws it; once it runs, it finishes, so a change is never left half
 * made. Never start one from inside another holding the same key: it would
 * wait for itself.
 */
export const serialized = <A, E, R>(
  kind: string,
  keys: ReadonlyArray<string>,
  effect: Effect.Effect<A, E, R>
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const queuedAt = yield* Clock.currentTimeMillis
    const run = Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan(
        "operation.wait_ms",
        (yield* Clock.currentTimeMillis) - queuedAt
      )
      return yield* Effect.uninterruptible(effect)
    })
    return yield* [...new Set(keys)]
      .sort()
      .reduceRight<Effect.Effect<A, E, R>>(
        (inner, key) => withKey(key, inner),
        run
      )
  }).pipe(
    Effect.withSpan("Operations.serialized", {
      attributes: { "operation.keys": keys.length, "operation.kind": kind },
    })
  )
