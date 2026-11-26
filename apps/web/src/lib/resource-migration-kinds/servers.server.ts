import { randomUUID } from "node:crypto"

import {
  DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
  relayCreateInstanceSchema,
  relaySnapshotSchema,
  type RelayInstance,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import {
  listInstanceGameAddressesEffect,
  setInstanceDomainOptOutEffect,
} from "@/effect/addresses"
import {
  countLinkableInstanceBackupsEffect,
  getBackupCatalogRecordEffect,
  linkInstanceBackupsEffect,
  reserveInstanceBackupEffect,
} from "@/effect/backups"
import { anyDomainConnectionEffect } from "@/effect/domains"
import { promiseEffect, recoverPromise } from "@/effect/promise"
import { publishBackupChange } from "@/lib/backup-realtime.server"
import { requireBackupStorageSelection } from "@/lib/backup-storage-selection.server"
import { databaseTable } from "@/lib/database-config"
import { reserveServerInstanceIdEffect } from "@/lib/provisioning.server"
import type { PersistedRelay } from "@/lib/relay-registry"
import { relayResourceLimitsRequest } from "@/lib/resource-limits.server"
import {
  accessHandOver,
  countAccess,
  fail,
  moveWebRoutes,
  ownerHandOver,
  recordedIn,
  relay,
  relayRequest,
  relays,
  schedulesHandOver,
  webRouteHostnames,
  type MigratedKind,
  type MigrationSide,
} from "@/lib/resource-migration-kinds/kind.server"
import { provisionServer } from "@/lib/server-provisioning.server"
import { brickRecipeDefinition } from "@/server/bricks"
import { loadInstanceRecipe } from "@/server/bricks.server"
import {
  moveInstanceDomainsEffect,
  provisionInstanceDomainBestEffort,
} from "@/server/addresses.server"

// A game server is made from the Brick snapshot, variables and limits its
// Relay lists for it, its files are its one folder, and it has everything a
// copy can be handed.
export const servers: MigratedKind = {
  kind: "instance",
  noun: "game server",
  nameLimit: 32,
  powered: true,
  copiedRunning: false,
  permissions: {
    copy: ["instance.files.read", "instance.configuration.read"],
    create: ["instance.create"],
    delete: "instance.delete",
    network: "instance.network.write",
  },
  reserveId: reserveServerInstanceIdEffect,
  describe: async (relay, id, subject) => {
    const instance = await Effect.runPromise(
      snapshotInstance(relay, id, subject)
    )
    if (!instance) return null
    const live = instance.resources?.storage.usedBytes
    return {
      limits: instance.pendingLimits ?? instance.limits,
      name: instance.name,
      provisioning: Boolean(instance.provisioning),
      running: instance.observedState !== "stopped",
      unbuildable: instance.brickSource
        ? null
        : "This server has no Brick to build a copy from",
      ...(live !== null && live !== undefined
        ? { usedBytes: live, usedFrom: "running" as const }
        : {
            usedBytes:
              instance.limits.diskBytes ?? DEFAULT_INSTANCE_DISK_LIMIT_BYTES,
            usedFrom: "limit" as const,
          }),
    }
  },
  // As its Relay reports them and as Hearth renamed them.
  takenNames: async (relay, subject) => {
    const { databasePool } = await import("@/lib/database")
    const [reported, [rows]] = await Promise.all([
      recoverPromise(
        () =>
          Effect.runPromise(snapshot(relay, subject)).then((instances) =>
            instances.map((instance) => instance.name)
          ),
        () => []
      ),
      databasePool.query<Array<RowDataPacket & { display_name: string }>>(
        `SELECT display_name FROM ${databaseTable("instance")}
          WHERE relay_id = ? AND display_name IS NOT NULL`,
        [relay.id]
      ),
    ])
    return [...new Set([...reported, ...rows.map((row) => row.display_name)])]
  },
  state: (relay, id, subject) =>
    snapshotInstance(relay, id, subject).pipe(
      Effect.map(
        (instance) =>
          instance && {
            provisioning: instance.provisioning
              ? {
                  error: instance.provisioning.error ?? null,
                  failed: instance.provisioning.phase === "failed",
                }
              : null,
            // A new game server is made stopped.
            ready: instance.observedState === "stopped",
            stopped: instance.observedState === "stopped",
          }
      )
    ),
  recorded: recordedIn("instance"),
  // From the exact Brick the old server was built from, with its settings,
  // and its limits unless the copy was given its own.
  prepare: Effect.fnUntraced(function* (
    { destination, source },
    migration,
    actor,
    options
  ) {
    const instance = yield* snapshotInstance(
      source,
      migration.source.id,
      actor.id
    )
    if (!instance?.brickSource) {
      return yield* fail(
        `${migration.source.name} has no Brick to build its copy from`
      )
    }
    return Effect.gen(function* () {
      const recipe = yield* promiseEffect(() =>
        loadInstanceRecipe(source, instance)
      )
      const diskLimitBytes =
        (options.limits ?? instance.pendingLimits ?? instance.limits)
          .diskBytes ?? DEFAULT_INSTANCE_DISK_LIMIT_BYTES
      const create = yield* Effect.try({
        try: () =>
          relayCreateInstanceSchema.parse({
            diskLimitBytes,
            ...relayResourceLimitsRequest(
              options.limits ?? instance.pendingLimits ?? instance.limits
            ),
            name: migration.destination.name,
            recipe: recipe.brickSource,
            recipeDefinition: brickRecipeDefinition(recipe.brick),
            start: false,
            variables: instance.variables ?? {},
          }),
        catch: (cause) => cause,
      })
      // A move takes the old server's domains along, so the copy isn't
      // given one of its own when it's provisioned.
      if (migration.mode === "migrate" && options.moveDomain) {
        yield* setInstanceDomainOptOutEffect(
          destination.id,
          migration.destination.id,
          true
        )
      }
      // Whoever copies a server owns the copy while it's built, so they may
      // fill it; a finished move hands it to the old server's owner.
      yield* promiseEffect(() =>
        provisionServer({
          create,
          idempotencyKey: migration.createKey,
          instanceId: migration.destination.id,
          ownerId: actor.id,
          relay: destination,
          requestedBy: actor.id,
        })
      )
    })
  }),
  // Its folder is its file root, under its own ID.
  sourceRoots: (_relayId, id) => Effect.succeed([id]),
  parts: (migration) =>
    Effect.succeed([
      { destination: migration.destination.id, source: migration.source.id },
    ]),
  // A full archive, to the destinations settled when it was asked for.
  // Under the copy's backup ID, a step cut off once it's reserved finds it,
  // so it's reserved once.
  backupFirst: Effect.fnUntraced(function* (migration, actor, backupId) {
    yield* promiseEffect(() =>
      requireBackupStorageSelection({
        relayId: migration.source.relayId,
        storageIds: migration.backupStorageIds,
        targetId: migration.source.id,
        targetKind: "instance",
        user: actor,
      })
    )
    if (yield* getBackupCatalogRecordEffect(backupId)) return
    const [source, destination] = yield* relays(migration)
    const dispatch = yield* reserveInstanceBackupEffect({
      backupId,
      createdBy: actor.id,
      mode: "full",
      name: `Before ${migration.mode === "migrate" ? "moving" : "copying"} to ${destination.name}`.slice(
        0,
        120
      ),
      relayId: source.id,
      requestedMaxBytes: null,
      storageIds: migration.backupStorageIds,
      targetId: migration.source.id,
      taskId: randomUUID(),
    })
    publishBackupChange(source.id, backupId)
    // Queued on the Relay now if it answers; otherwise reconciling the
    // Relay's backups, as each check does, queues it.
    yield* promiseEffect(async () => {
      const { dispatchBackupTask } = await import("@/lib/backup-reconciliation")
      await dispatchBackupTask(source, dispatch, actor.id)
    }).pipe(Effect.ignore)
  }),
  // Starting it provisions its domain again, as any start of it does.
  started: Effect.fnUntraced(function* (relay, id, subject) {
    const instance = yield* snapshotInstance(relay, id, subject)
    if (!instance) return
    yield* promiseEffect(() =>
      provisionInstanceDomainBestEffort(instance, relay.id)
    )
  }),
  handOver: {
    owner: ownerHandOver("instance"),
    schedules: schedulesHandOver("instance"),
    access: accessHandOver("instance"),
    backups: (migration, actor) =>
      linkInstanceBackupsEffect({
        from: sideOf(migration.source),
        linkedBy: actor.id,
        to: sideOf(migration.destination),
      }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            publishBackupChange(migration.source.relayId)
            publishBackupChange(migration.destination.relayId)
          })
        ),
        Effect.asVoid
      ),
    domains: Effect.fnUntraced(function* (migration, actor) {
      const destination = yield* relay(migration.destination.relayId)
      const instance = yield* snapshotInstance(
        destination,
        migration.destination.id,
        actor.id
      )
      if (!instance) return yield* fail("The new server is gone")
      yield* moveInstanceDomainsEffect(sideOf(migration.source), {
        ...instance,
        relayId: destination.id,
      })
    }),
    routes: (migration, actor) => moveWebRoutes("instance", migration, actor),
  },
  handOverCounts: async (relay, id, user, allowed) => {
    const { runAppEffect } = await import("@/effect/runtime")
    const [[managed, addresses], webRoutes, access, backups] =
      await Promise.all([
        runAppEffect(
          "resourceMigrations.preview.domains",
          Effect.all(
            [
              anyDomainConnectionEffect(),
              listInstanceGameAddressesEffect(relay.id, id),
            ],
            { concurrency: 2 }
          )
        ),
        allowed.network
          ? webRouteHostnames("instance", relay, id, user.id)
          : [],
        countAccess("instance", relay.id, id),
        allowed.backups
          ? runAppEffect(
              "resourceMigrations.preview.backups",
              countLinkableInstanceBackupsEffect(relay.id, id)
            )
          : { anywhere: 0, here: 0, total: 0 },
      ])
    return {
      access,
      backups,
      domains: {
        managed,
        names: addresses
          .filter((address) => address.status !== "removing")
          .map((address) => address.hostname),
      },
      webRoutes,
    }
  },
}

function snapshot(
  relay: PersistedRelay,
  subject: string | undefined
): Effect.Effect<ReadonlyArray<RelayInstance>, unknown> {
  return relayRequest(relay, "relay.snapshot", subject, {}).pipe(
    Effect.map((value) => relaySnapshotSchema.parse(value).instances)
  )
}

function snapshotInstance(
  relay: PersistedRelay,
  id: string,
  subject: string | undefined
): Effect.Effect<RelayInstance | null, unknown> {
  return snapshot(relay, subject).pipe(
    Effect.map(
      (instances) => instances.find((instance) => instance.id === id) ?? null
    )
  )
}

function sideOf(side: MigrationSide) {
  return { instanceId: side.id, relayId: side.relayId }
}
