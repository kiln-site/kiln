import { logException } from "@workspace/telemetry"
import { Context, Effect, Queue, Schedule } from "effect"

import { forkAppWorker } from "@/effect/runtime"
import {
  instanceDirectoryMetadata,
  type DirectoryInstance,
} from "@/lib/instance-directory"
import { syncInstanceRegistryEffect } from "@/lib/instance-registry"
import {
  relayConnectionIds,
  relayConnectionInstances,
} from "@/lib/relay-connection"
import {
  publishRealtimeChange,
  subscribeRealtimeChanges,
} from "@/lib/realtime-source.server"

export class InstanceDirectorySource extends Context.Service<
  InstanceDirectorySource,
  {
    readonly instances: (
      relayId: string
    ) => ReadonlyArray<DirectoryInstance> | null
    readonly subscribe: (changed: (relayId: string) => void) => () => void
  }
>()("hearth/InstanceDirectorySource") {}

// Coalesce bursts, serialize database writes, and read the latest authenticated
// snapshot when work starts. A disconnect must never prune the stored directory.
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
  while (true) {
    yield* Queue.take(wake)
    const batch = Array.from(pending)
    pending.clear()
    for (const relayId of batch) {
      const instances = source.instances(relayId)
      if (instances === null) continue
      const signature = JSON.stringify(
        instances
          .map((instance) => [
            instance.id,
            instance.name,
            instanceDirectoryMetadata(instance),
          ])
          .sort(([left], [right]) => left!.localeCompare(right!))
      )
      if (committed.get(relayId) === signature) continue
      yield* syncInstanceRegistryEffect(relayId, instances).pipe(
        Effect.retry(
          Schedule.exponential(100).pipe(Schedule.upTo({ times: 3 }))
        ),
        Effect.tap(() =>
          Effect.sync(() => {
            committed.set(relayId, signature)
            publishRealtimeChange({
              type: "hearth.invalidate",
              topics: ["instance-directory"],
              audience: { kind: "relays", relayIds: [relayId] },
              scope: { relayId },
            })
          })
        ),
        Effect.catch((error) =>
          logException(error, {
            operation: "instances.directory.sync",
            attributes: { "relay.id": relayId },
          }).pipe(
            // Recover after a database outage even when the Relay's metadata
            // does not change again. Other Relays can progress meanwhile.
            Effect.andThen(
              Effect.sleep(5_000).pipe(
                Effect.andThen(Effect.sync(() => enqueue(relayId))),
                Effect.forkChild,
                Effect.asVoid
              )
            )
          )
        )
      )
    }
  }
})

declare global {
  var kilnInstanceDirectoryWorker: ReturnType<typeof forkAppWorker> | undefined
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
              event.type === "instance.upsert" ||
              event.type === "instance.delete"
            )
              changed(event.relayId)
          })
          // A connection can authenticate while the app runtime is starting.
          // Seed existing connections after subscribing so that event is not lost.
          for (const relayId of relayConnectionIds()) changed(relayId)
          return unsubscribe
        },
      }),
      Effect.scoped,
      Effect.ensuring(
        Effect.sync(() => {
          globalThis.kilnInstanceDirectoryWorker = undefined
        })
      )
    )
  )
}
