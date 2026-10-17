import type { RelayInstance } from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import {
  instanceDirectoryMetadata,
  type DirectoryInstance,
} from "@/lib/instance-directory"
import { databaseTable } from "@/lib/database-config"

export function backfillInstanceSourceNames(
  relayId: string,
  instances: ReadonlyArray<DirectoryInstance>
): Promise<void> {
  return runAppEffect(
    "instances.registry.backfillSourceNames",
    backfillInstanceSourceNamesEffect(relayId, instances)
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
  yield* database.transaction("instances.registry.registerPrepared", (tx) =>
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
})

export function unregisterInstance(relayId: string, instanceId: string) {
  return runAppEffect(
    "instances.registry.unregister",
    Effect.gen(function* () {
      const database = yield* Database
      yield* database.execute(
        "instances.registry.unregister",
        `DELETE FROM ${databaseTable("instance")}
          WHERE relay_id = ? AND instance_id = ?`,
        [relayId, instanceId]
      )
    })
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
  // existing records; the live synchronizer owns additions and removals.
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

export const syncInstanceRegistryEffect = Effect.fn("instances.registry.sync")(
  function* (relayId: string, instances: ReadonlyArray<DirectoryInstance>) {
    yield* Effect.annotateCurrentSpan({
      "relay.id": relayId,
      "instance.count": instances.length,
    })
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.transaction("instances.registry.sync", (transaction) =>
      Effect.gen(function* () {
        if (instances.length) {
          const values = instances
            .map(() => "(?, ?, NULL, ?, ?, ?, ?)")
            .join(", ")
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("instance")}
              (relay_id, instance_id, display_name, source_name, directory_metadata, created_at,
               updated_at)
         VALUES ${values}
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
            ])
          )
          const placeholders = instances.map(() => "?").join(", ")
          yield* transaction.execute(
            `DELETE FROM ${databaseTable("instance")}
          WHERE relay_id = ?
            AND instance_id NOT IN (${placeholders})
            AND (
              provisioning_reserved_until IS NULL
              OR provisioning_reserved_until <= ?
            )`,
            [relayId, ...instances.map((instance) => instance.id), now]
          )
          return
        }
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("instance")}
            WHERE relay_id = ?
              AND (
                provisioning_reserved_until IS NULL
                OR provisioning_reserved_until <= ?
              )`,
          [relayId, now]
        )
      })
    )
  }
)
