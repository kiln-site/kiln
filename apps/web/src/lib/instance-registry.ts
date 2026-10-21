import type { RelayInstance } from "@workspace/contracts"
import { Clock, Effect, Schedule, Semaphore } from "effect"

import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import {
  instanceDirectoryMetadata,
  type DirectoryInstance,
} from "@/lib/instance-directory"
import { databaseTable } from "@/lib/database-config"
import { wakePollingWorker } from "@/lib/polling-worker"
import { publishRealtimeChange } from "@/lib/realtime-source.server"

export function backfillInstanceSourceNames(
  relayId: string,
  instances: ReadonlyArray<DirectoryInstance>
): Promise<void> {
  return runAppEffect(
    "instances.registry.backfillSourceNames",
    backfillInstanceSourceNamesEffect(relayId, instances)
  )
}

interface RelayLifecycle {
  readonly writes: Semaphore.Semaphore
  readonly created: Set<string>
  readonly deleted: Set<string>
}

const lifecycles = new Map<string, RelayLifecycle>()

function relayLifecycle(relayId: string): RelayLifecycle {
  let lifecycle = lifecycles.get(relayId)
  if (!lifecycle) {
    lifecycle = {
      writes: Semaphore.makeUnsafe(1),
      created: new Set(),
      deleted: new Set(),
    }
    lifecycles.set(relayId, lifecycle)
  }
  return lifecycle
}

// Hearth's own creates and deletes take their Relay's lifecycle permit and
// are remembered for the life of the process. The startup reconciliation
// takes the same permit, so committing a snapshot read moments earlier can
// never undo them. Instance IDs are never reused, so nothing is forgotten.
function lifecycleWrite(
  relayId: string,
  change: { created: string } | { deleted: string }
) {
  const lifecycle = relayLifecycle(relayId)
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    lifecycle.writes.withPermit(
      Effect.suspend(() => {
        if ("created" in change) lifecycle.created.add(change.created)
        else lifecycle.deleted.add(change.deleted)
        return effect
      })
    )
}

// Lifecycle writes can land after the Relay's own update reached browsers,
// so open directories reread once the record changed.
function publishDirectoryChange(relayId: string) {
  return Effect.sync(() =>
    publishRealtimeChange({
      type: "hearth.invalidate",
      topics: ["instance-directory"],
      audience: { kind: "relays", relayIds: [relayId] },
      scope: { relayId },
    })
  )
}

export function registerPreparedInstance(
  relayId: string,
  instance: DirectoryInstance,
  ownerId: string
): Promise<void> {
  return runAppEffect(
    "instances.registry.registerPrepared",
    registerPreparedInstanceEffect(relayId, instance, ownerId)
  )
}

export function updateInstanceSourceName(
  relayId: string,
  instance: Pick<RelayInstance, "id" | "name">
): Promise<void> {
  return runAppEffect(
    "instances.registry.updateSourceName",
    updateInstanceSourceNameEffect(relayId, instance)
  )
}

export function reservePreparedInstance(
  relayId: string,
  instance: Pick<RelayInstance, "id">,
  ownerId: string
): Promise<void> {
  return runAppEffect(
    "instances.registry.reservePrepared",
    reservePreparedInstanceEffect(relayId, instance, ownerId)
  )
}

export const reservePreparedInstanceEffect = Effect.fn(
  "instances.registry.reservePrepared"
)(function* (
  relayId: string,
  instance: Pick<RelayInstance, "id">,
  ownerId: string
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "instances.registry.reservePrepared",
    `INSERT INTO ${databaseTable("instance")}
       (relay_id, instance_id, display_name, owner_id,
        provisioning_reserved_until, created_at, updated_at)
     VALUES (?, ?, NULL, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       owner_id = COALESCE(owner_id, VALUES(owner_id)),
       provisioning_reserved_until = VALUES(provisioning_reserved_until),
       updated_at = VALUES(updated_at)`,
    [relayId, instance.id, ownerId, now + 2 * 60_000, now, now]
  )
})

export const registerPreparedInstanceEffect = Effect.fn(
  "instances.registry.registerPrepared"
)(function* (relayId: string, instance: DirectoryInstance, ownerId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* lifecycleWrite(relayId, { created: instance.id })(
    database.transaction("instances.registry.registerPrepared", (tx) =>
      Effect.gen(function* () {
        yield* tx.execute(
          `INSERT INTO ${databaseTable("instance")}
           (relay_id, instance_id, display_name, source_name, directory_metadata, owner_id,
            created_at, updated_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           source_name = VALUES(source_name),
           directory_metadata = VALUES(directory_metadata),
           owner_id = COALESCE(owner_id, VALUES(owner_id)),
           provisioning_reserved_until = NULL,
           updated_at = VALUES(updated_at)`,
          [
            relayId,
            instance.id,
            instance.name.slice(0, 255),
            instanceDirectoryMetadata(instance),
            ownerId,
            now,
            now,
          ]
        )
        yield* tx.execute(
          `INSERT INTO ${databaseTable("instance_post_provision")}
           (relay_id, instance_id, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           next_attempt_at = VALUES(next_attempt_at),
           last_error = NULL,
           updated_at = VALUES(updated_at)`,
          [relayId, instance.id, now, now, now]
        )
      })
    )
  )
  yield* Effect.sync(() => wakePollingWorker("Instances.postProvision"))
})

export const unregisterInstanceEffect = Effect.fn(
  "instances.registry.unregister"
)(function* (relayId: string, instanceId: string) {
  const database = yield* Database
  yield* lifecycleWrite(relayId, { deleted: instanceId })(
    database.execute(
      "instances.registry.unregister",
      `DELETE FROM ${databaseTable("instance")}
        WHERE relay_id = ? AND instance_id = ?`,
      [relayId, instanceId]
    )
  )
  yield* publishDirectoryChange(relayId)
})

export function unregisterInstance(relayId: string, instanceId: string) {
  return runAppEffect(
    "instances.registry.unregister",
    unregisterInstanceEffect(relayId, instanceId)
  )
}

export const backfillInstanceSourceNamesEffect = Effect.fn(
  "instances.registry.backfillSourceNames"
)(function* (relayId: string, instances: ReadonlyArray<DirectoryInstance>) {
  if (instances.length === 0) return
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const values = instances
    .map(() => "SELECT ? AS instance_id, ? AS source_name, ? AS metadata")
    .join(" UNION ALL ")
  // Cached startup snapshots may arrive after a live deletion. Only fill
  // existing records; Hearth's create and delete paths own which exist.
  yield* database.execute(
    "instances.registry.backfillSourceNames",
    `UPDATE ${databaseTable("instance")} AS existing_instance
       JOIN (${values}) AS incoming
         ON existing_instance.instance_id = incoming.instance_id
        AND existing_instance.relay_id = ?
        SET existing_instance.updated_at = IF(existing_instance.source_name IS NULL, ?, existing_instance.updated_at),
            existing_instance.source_name = COALESCE(existing_instance.source_name, incoming.source_name),
            existing_instance.directory_metadata = COALESCE(existing_instance.directory_metadata, incoming.metadata)`,
    [
      ...instances.flatMap((instance) => [
        instance.id,
        instance.name.slice(0, 255),
        instanceDirectoryMetadata(instance),
      ]),
      relayId,
      now,
    ]
  )
})

export const updateInstanceSourceNameEffect = Effect.fn(
  "instances.registry.updateSourceName"
)(function* (relayId: string, instance: Pick<RelayInstance, "id" | "name">) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "instances.registry.updateSourceName",
    `UPDATE ${databaseTable("instance")}
       SET source_name = ?, updated_at = ?
     WHERE relay_id = ? AND instance_id = ?`,
    [instance.name.slice(0, 255), now, relayId, instance.id]
  )
})

// Records each instance's name and stable metadata, creating missing rows.
function upsertInstancesStatement(
  relayId: string,
  instances: ReadonlyArray<DirectoryInstance>,
  now: number
) {
  return [
    `INSERT INTO ${databaseTable("instance")}
       (relay_id, instance_id, display_name, source_name, directory_metadata,
        created_at, updated_at)
     VALUES ${instances.map(() => "(?, ?, NULL, ?, ?, ?, ?)").join(", ")}
     ON DUPLICATE KEY UPDATE
       source_name = VALUES(source_name),
       directory_metadata = VALUES(directory_metadata),
       updated_at = VALUES(updated_at)`,
    instances.flatMap((instance) => [
      relayId,
      instance.id,
      instance.name.slice(0, 255),
      instanceDirectoryMetadata(instance),
      now,
      now,
    ]),
  ] as const
}

/**
 * Refreshes the name and metadata of servers Hearth already records. Live
 * snapshots never create or remove records: Hearth records a server when it
 * creates one and removes the record when it deletes one, so a snapshot read
 * before a deletion cannot bring the server back.
 */
export const updateInstanceDirectoryEffect = Effect.fn(
  "instances.directory.update"
)(function* (relayId: string, instances: ReadonlyArray<DirectoryInstance>) {
  yield* Effect.annotateCurrentSpan({
    "relay.id": relayId,
    "instance.count": instances.length,
  })
  if (instances.length === 0) return
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const incoming = instances
    .map(() => "SELECT ? AS instance_id, ? AS source_name, ? AS metadata")
    .join(" UNION ALL ")
  yield* database.execute(
    "instances.directory.update",
    `UPDATE ${databaseTable("instance")} AS existing_instance
       JOIN (${incoming}) AS incoming
         ON existing_instance.instance_id = incoming.instance_id
        AND existing_instance.relay_id = ?
        SET existing_instance.source_name = incoming.source_name,
            existing_instance.directory_metadata = incoming.metadata,
            existing_instance.updated_at = ?`,
    [
      ...instances.flatMap((instance) => [
        instance.id,
        instance.name.slice(0, 255),
        instanceDirectoryMetadata(instance),
      ]),
      relayId,
      now,
    ]
  )
})

/** Records a server Hearth created outside the provisioning flow. */
export const recordCreatedInstanceEffect = Effect.fn(
  "instances.registry.recordCreated"
)(function* (relayId: string, instance: DirectoryInstance) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* lifecycleWrite(relayId, { created: instance.id })(
    database.execute(
      "instances.registry.recordCreated",
      ...upsertInstancesStatement(relayId, [instance], now)
    )
  )
  yield* publishDirectoryChange(relayId)
})

/** Removes the record of a server its Relay has deleted. */
export const removeDeletedInstanceEffect = Effect.fn(
  "instances.registry.removeDeleted"
)(function* (relayId: string, instanceId: string) {
  yield* unregisterInstanceEffect(relayId, instanceId).pipe(
    Effect.retry(Schedule.exponential(100).pipe(Schedule.upTo({ times: 3 })))
  )
})

/**
 * Reconciles a Relay's records with a fresh snapshot when Hearth starts. The
 * snapshot was read moments before this commits, so servers Hearth created
 * or deleted on the Relay in between keep their outcome.
 */
export const syncInstanceRegistryEffect = Effect.fn("instances.registry.sync")(
  function* (relayId: string, instances: ReadonlyArray<DirectoryInstance>) {
    yield* Effect.annotateCurrentSpan({
      "relay.id": relayId,
      "instance.count": instances.length,
    })
    const database = yield* Database
    const lifecycle = relayLifecycle(relayId)
    yield* lifecycle.writes.withPermit(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis
        const listed = instances.filter(
          (instance) => !lifecycle.deleted.has(instance.id)
        )
        // Keep what the snapshot lists and what Hearth itself created.
        const kept = [
          ...new Set([
            ...listed.map((instance) => instance.id),
            ...lifecycle.created,
          ]),
        ]
        yield* database.transaction("instances.registry.sync", (transaction) =>
          Effect.gen(function* () {
            if (listed.length)
              yield* transaction.execute(
                ...upsertInstancesStatement(relayId, listed, now)
              )
            yield* transaction.execute(
              `DELETE FROM ${databaseTable("instance")}
                WHERE relay_id = ?
                  ${kept.length ? `AND instance_id NOT IN (${kept.map(() => "?").join(", ")})` : ""}
                  AND (
                    provisioning_reserved_until IS NULL
                    OR provisioning_reserved_until <= ?
                  )`,
              [relayId, ...kept, now]
            )
          })
        )
      })
    )
  }
)

export function syncInstanceRegistry(
  relayId: string,
  instances: ReadonlyArray<DirectoryInstance>
): Promise<void> {
  return runAppEffect(
    "instances.registry.sync",
    syncInstanceRegistryEffect(relayId, instances)
  )
}
