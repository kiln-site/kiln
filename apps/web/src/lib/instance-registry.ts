import type { RelayInstance } from "@workspace/contracts"
import { Effect } from "effect"

import { Database } from "@/effect/database"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"

export function syncInstanceRegistry(
  relayId: string,
  instances: ReadonlyArray<Pick<RelayInstance, "id" | "name">>
): Promise<void> {
  return runAppEffect(
    "instances.registry.sync",
    syncInstanceRegistryEffect(relayId, instances)
  )
}

export function backfillInstanceSourceNames(
  relayId: string,
  instances: ReadonlyArray<Pick<RelayInstance, "id" | "name">>
): Promise<void> {
  return runAppEffect(
    "instances.registry.backfillSourceNames",
    backfillInstanceSourceNamesEffect(relayId, instances)
  )
}

export function registerPreparedInstance(
  relayId: string,
  instance: Pick<RelayInstance, "id" | "name">,
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
  yield* database.execute(
    "instances.registry.reservePrepared",
    `INSERT INTO ${databaseTable("instance")}
       (relay_id, instance_id, display_name, owner_id,
        provisioning_reserved_until)
     VALUES (?, ?, NULL, ?, DATE_ADD(CURRENT_TIMESTAMP(3), INTERVAL 2 MINUTE))
     ON DUPLICATE KEY UPDATE
       owner_id = COALESCE(owner_id, VALUES(owner_id)),
       provisioning_reserved_until = VALUES(provisioning_reserved_until),
       updated_at = CURRENT_TIMESTAMP(3)`,
    [relayId, instance.id, ownerId]
  )
})

export const registerPreparedInstanceEffect = Effect.fn(
  "instances.registry.registerPrepared"
)(function* (
  relayId: string,
  instance: Pick<RelayInstance, "id" | "name">,
  ownerId: string
) {
  const database = yield* Database
  yield* database.transaction("instances.registry.registerPrepared", (tx) =>
    Effect.gen(function* () {
      yield* tx.execute(
        `INSERT INTO ${databaseTable("instance")}
           (relay_id, instance_id, display_name, source_name, owner_id)
         VALUES (?, ?, NULL, ?, ?)
         ON DUPLICATE KEY UPDATE
           source_name = VALUES(source_name),
           owner_id = COALESCE(owner_id, VALUES(owner_id)),
           provisioning_reserved_until = NULL,
           updated_at = CURRENT_TIMESTAMP(3)`,
        [relayId, instance.id, instance.name.slice(0, 255), ownerId]
      )
      yield* tx.execute(
        `INSERT INTO ${databaseTable("instance_post_provision")}
           (relay_id, instance_id)
         VALUES (?, ?)
         ON DUPLICATE KEY UPDATE
           next_attempt_at = CURRENT_TIMESTAMP(3),
           last_error = NULL`,
        [relayId, instance.id]
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
)(function* (
  relayId: string,
  instances: ReadonlyArray<Pick<RelayInstance, "id" | "name">>
) {
  if (instances.length === 0) return
  const database = yield* Database
  const values = instances.map(() => "(?, ?, NULL, ?)").join(", ")
  yield* database.execute(
    "instances.registry.backfillSourceNames",
    `INSERT INTO ${databaseTable("instance")}
       (relay_id, instance_id, display_name, source_name)
     VALUES ${values}
     ON DUPLICATE KEY UPDATE
       updated_at = IF(source_name IS NULL, CURRENT_TIMESTAMP(3), updated_at),
       source_name = COALESCE(source_name, VALUES(source_name))`,
    instances.flatMap((instance) => [
      relayId,
      instance.id,
      instance.name.slice(0, 255),
    ])
  )
})

export const updateInstanceSourceNameEffect = Effect.fn(
  "instances.registry.updateSourceName"
)(function* (
  relayId: string,
  instance: Pick<RelayInstance, "id" | "name">
) {
  const database = yield* Database
  yield* database.execute(
    "instances.registry.updateSourceName",
    `UPDATE ${databaseTable("instance")}
       SET source_name = ?, updated_at = CURRENT_TIMESTAMP(3)
     WHERE relay_id = ? AND instance_id = ?`,
    [instance.name.slice(0, 255), relayId, instance.id]
  )
})

export const syncInstanceRegistryEffect = Effect.fn("instances.registry.sync")(
  function* (
    relayId: string,
    instances: ReadonlyArray<Pick<RelayInstance, "id" | "name">>
  ) {
    const database = yield* Database
    yield* database.transaction("instances.registry.sync", (transaction) =>
      Effect.gen(function* () {
        if (instances.length) {
          const values = instances.map(() => "(?, ?, NULL, ?)").join(", ")
          yield* transaction.execute(
            `INSERT INTO ${databaseTable("instance")}
              (relay_id, instance_id, display_name, source_name)
         VALUES ${values}
         ON DUPLICATE KEY UPDATE
           source_name = VALUES(source_name),
           updated_at = CURRENT_TIMESTAMP(3)`,
            instances.flatMap((instance) => [
              relayId,
              instance.id,
              instance.name.slice(0, 255),
            ])
          )
          const placeholders = instances.map(() => "?").join(", ")
          yield* transaction.execute(
            `DELETE FROM ${databaseTable("instance")}
          WHERE relay_id = ?
            AND instance_id NOT IN (${placeholders})
            AND (
              provisioning_reserved_until IS NULL
              OR provisioning_reserved_until <= CURRENT_TIMESTAMP(3)
            )`,
            [relayId, ...instances.map((instance) => instance.id)]
          )
          return
        }
        yield* transaction.execute(
          `DELETE FROM ${databaseTable("instance")}
            WHERE relay_id = ?
              AND (
                provisioning_reserved_until IS NULL
                OR provisioning_reserved_until <= CURRENT_TIMESTAMP(3)
              )`,
          [relayId]
        )
      })
    )
  }
)
