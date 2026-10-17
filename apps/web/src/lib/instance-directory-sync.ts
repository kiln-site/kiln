import { logException } from "@workspace/telemetry"
import { Cause, Context, Effect, Fiber, Queue, Schedule } from "effect"

import { forkAppWorker } from "@/effect/runtime"
import {
  instanceDirectoryMetadata,
  type DirectoryInstance,
} from "@/lib/instance-directory"
import { updateInstanceDirectoryEffect } from "@/lib/instance-registry"
import {
  relayConnectionIds,
  relayConnectionInstances,
} from "@/lib/relay-connection"
import {
  publishRealtimeChange,
  subscribeRealtimeChanges,
} from "@/lib/realtime-source.server"

/** Authenticated Relay snapshots, and a signal when one changes. */
export class InstanceDirectorySource extends Context.Service<
  InstanceDirectorySource,
  {
    readonly instances: (
      relayId: string
    ) => ReadonlyArray<DirectoryInstance> | null
    readonly subscribe: (changed: (relayId: string) => void) => () => void
  }
>()("hearth/InstanceDirectorySource") {}

const retryDelay = "5 seconds"

// Coalesces bursts, serializes database writes, and reads the latest
// snapshot when work starts. It only refreshes records Hearth already holds;
// Hearth's create and delete paths and the startup reconciliation own which
// records exist.
export const syncInstanceDirectories = Effect.gen(function* () {
  const source = yield* InstanceDirectorySource
  const wake = yield* Queue.sliding<void>(1)
  yield* Effect.addFinalizer(() => Queue.shutdown(wake))
  const pending = new Set<string>()
  const committed = new Map<string, string>()
  const enqueue = (relayId: string) => {
    pending.add(relayId)
    Queue.offerUnsafe(wake, undefined)
  }
  yield* Effect.acquireRelease(
    Effect.sync(() => source.subscribe(enqueue)),
    (unsubscribe) => Effect.sync(unsubscribe)
  )
  const syncRelay = Effect.fnUntraced(function* (relayId: string) {
    const instances = source.instances(relayId)
    if (instances === null) return
    const signature = JSON.stringify(
      instances
        .map((instance) => [
          instance.id,
          instance.name,
          instanceDirectoryMetadata(instance),
        ])
        .sort(([left], [right]) => left!.localeCompare(right!))
    )
    if (committed.get(relayId) === signature) return
    yield* updateInstanceDirectoryEffect(relayId, instances).pipe(
      Effect.retry(Schedule.exponential(100).pipe(Schedule.upTo({ times: 3 })))
    )
    committed.set(relayId, signature)
    publishRealtimeChange({
      type: "hearth.invalidate",
      topics: ["instance-directory"],
      audience: { kind: "relays", relayIds: [relayId] },
      scope: { relayId },
    })
  })
  while (true) {
    yield* Queue.take(wake)
    const batch = Array.from(pending)
    pending.clear()
    for (const relayId of batch) {
      yield* syncRelay(relayId).pipe(
        Effect.catchCause((cause) =>
          logException(Cause.squash(cause), {
            operation: "instances.directory.sync",
            attributes: { "relay.id": relayId },
          }).pipe(
            // Recover after a database outage even when the Relay's metadata
            // does not change again. Other Relays progress meanwhile.
            Effect.andThen(
              Effect.sleep(retryDelay).pipe(
                Effect.andThen(Effect.sync(() => enqueue(relayId))),
                Effect.forkChild
              )
            )
          )
        )
      )
    }
  }
})

declare global {
  var kilnInstanceDirectoryWorker: Fiber.Fiber<void> | undefined
}

export function startInstanceDirectorySync() {
  globalThis.kilnInstanceDirectoryWorker ??= forkAppWorker(
    syncInstanceDirectories.pipe(
      Effect.provideService(InstanceDirectorySource, {
        instances: relayConnectionInstances,
        subscribe: (changed) => {
          const unsubscribe = subscribeRealtimeChanges((event) => {
            if (
              event.type === "relay.snapshot.reset" ||
              event.type === "relay.snapshot.delta" ||
              event.type === "relay.state" ||
              event.type === "instance.upsert"
            )
              changed(event.relayId)
          })
          // A connection can authenticate while the app runtime is starting.
          // Seed existing connections after subscribing so that event is not lost.
          for (const relayId of relayConnectionIds()) changed(relayId)
          return unsubscribe
        },
      }),
      Effect.scoped
    )
  )
}

/** Runtime disposal does not interrupt forked workers, so stop it first. */
export function stopInstanceDirectorySync(): Promise<void> {
  const worker = globalThis.kilnInstanceDirectoryWorker
  globalThis.kilnInstanceDirectoryWorker = undefined
  return worker ? Effect.runPromise(Fiber.interrupt(worker)) : Promise.resolve()
}

// In development, a reloaded module starts a worker running its new code.
if (import.meta.hot) import.meta.hot.dispose(() => stopInstanceDirectorySync())
