import {
  NO_RESOURCE_LIMITS,
  databaseEngineHasNamedDatabase,
  databaseEngineSupportsLogicalBackups,
  databaseFileRootId,
  relayControlDeadlineMs,
  relayManagedDatabaseSchema,
  resourceLimitsEqual,
  type DatabaseEngine,
  type RelayManagedDatabase,
} from "@workspace/contracts"
import { Effect } from "effect"
import type { RowDataPacket } from "mysql2/promise"
import { z } from "zod"

import { Database } from "@/effect/database"
import { reserveInstanceIdEffect } from "@/effect/instance-ids"
import { promiseEffect } from "@/effect/promise"
import { databaseTable } from "@/lib/database-config"
import { type PersistedRelay } from "@/lib/relay-registry"

import {
  accessHandOver,
  countAccess,
  fail,
  ownerHandOver,
  recordedIn,
  relays,
  type MigratedKind,
} from "@/lib/resource-migration-kinds/kind.server"

// A database is made from the Brick, version, database name and username
// of the old one, with a password of its own, and its data is its dump: it
// has to run to be dumped, so it's never stopped to be copied. An engine
// Kiln can't dump is copied empty.
export const databases: MigratedKind = {
  kind: "database",
  noun: "database",
  nameLimit: 120,
  powered: true,
  copiedRunning: true,
  permissions: {
    // Its Relay dumps and restores it as backups do, with no login from
    // whoever asks, so copying one takes what taking a backup off it does.
    copy: ["database.read", "backup.create", "backup.download"],
    create: "database.create",
    delete: "database.delete",
    network: "database.network.write",
  },
  reserveId: (createKey) =>
    reserveInstanceIdEffect("database", `database.copy:${createKey}`),
  describe: async (relay, id, subject) => {
    const database = await relayDatabase(relay, id, subject)
    if (!database) return null
    const dumped = databaseEngineSupportsLogicalBackups(database.engine)
    const running = database.observedState !== "stopped"
    return {
      limits: database.limits,
      name: database.name,
      provisioning: Boolean(database.provisioning),
      running,
      unbuildable:
        dumped && database.observedState !== "running"
          ? "Start this database first: it has to run to be copied"
          : null,
      usedBytes: database.diskUsedBytes ?? database.limits.diskBytes,
      usedFrom: database.diskUsedBytes === null ? "limit" : "running",
    }
  },
  takenNames: async (relay) => {
    const { databasePool } = await import("@/lib/database")
    const [rows] = await databasePool.query<
      Array<RowDataPacket & { name: string }>
    >(`SELECT name FROM ${databaseTable("database")} WHERE relay_id = ?`, [
      relay.id,
    ])
    return rows.map((row) => row.name)
  },
  state: (relay, id, subject) =>
    promiseEffect(() => relayDatabase(relay, id, subject)).pipe(
      Effect.map(
        (database) =>
          database && {
            provisioning: database.provisioning
              ? {
                  error: database.provisioning.error ?? null,
                  failed: database.provisioning.phase === "failed",
                }
              : null,
            // A new database is made running, and has to be to take a dump.
            ready: database.observedState === "running",
            stopped: database.observedState === "stopped",
          }
      )
    ),
  recorded: recordedIn("database"),
  prepare: Effect.fnUntraced(function* (
    { source },
    migration,
    actor,
    _options
  ) {
    const [record, running] = yield* Effect.all(
      [
        databaseRecord(migration.source),
        promiseEffect(() =>
          relayDatabase(source, migration.source.id, actor.id)
        ),
      ],
      { concurrency: 2 }
    )
    if (!record || !running) {
      return yield* fail(`${migration.source.name} is no longer on its Relay`)
    }
    return Effect.gen(function* () {
      // Made already, by this step before it was cut short: its Relay
      // carries on creating it.
      if (
        yield* recordedIn("database")(
          migration.destination.relayId,
          migration.destination.id
        )
      ) {
        return
      }
      const { createDatabaseHandler } = yield* promiseEffect(
        () => import("@/server/database-create.server")
      )
      yield* promiseEffect(() =>
        createDatabaseHandler(
          actor,
          {
            brick: record.brick_source,
            ...(databaseEngineHasNamedDatabase(record.engine)
              ? { databaseName: record.database_name }
              : {}),
            id: migration.destination.id,
            name: migration.destination.name,
            relayId: migration.destination.relayId,
            username: record.username,
            variables: running.variables,
          },
          migration.destination.id
        )
      )
    })
  }),
  sourceRoots: (relayId, id) =>
    databaseRecord({ id, relayId }).pipe(
      Effect.map((record) =>
        record && databaseEngineSupportsLogicalBackups(record.engine)
          ? [databaseFileRootId(id)]
          : []
      )
    ),
  parts: (migration) =>
    databaseRecord(migration.source).pipe(
      Effect.map((record) =>
        record && databaseEngineSupportsLogicalBackups(record.engine)
          ? [
              {
                destination: databaseFileRootId(migration.destination.id),
                source: databaseFileRootId(migration.source.id),
              },
            ]
          : []
      )
    ),
  // Its limits, the copy's own or the old one's, which creating a database
  // doesn't take.
  settled: Effect.fnUntraced(function* (migration, actor, options) {
    const [source, destination] = yield* relays(migration)
    const limits =
      options.limits ??
      (yield* promiseEffect(() =>
        relayDatabase(source, migration.source.id, actor.id)
      ))?.limits
    if (!limits || resourceLimitsEqual(limits, NO_RESOURCE_LIMITS)) return
    yield* promiseEffect(async () => {
      const { relayRpc } = await import("@/lib/relay-connection")
      await relayRpc(
        destination,
        "instance.limits.write",
        { id: migration.destination.id, kind: "database", limits },
        relayControlDeadlineMs("instance.limits.write"),
        actor.id
      )
    })
  }),
  handOver: {
    owner: ownerHandOver("database"),
    access: accessHandOver("database"),
  },
  handOverCounts: async (relay, id) => ({
    access: await countAccess("database", relay.id, id),
    backups: { anywhere: 0, here: 0, total: 0 },
    domains: { managed: false, names: [] },
    webRoutes: [],
  }),
  warnings: async (relay, id, subject) => {
    const database = await relayDatabase(relay, id, subject)
    if (!database) return { duplicate: [], migrate: [] }
    const dumped = databaseEngineSupportsLogicalBackups(database.engine)
    const data = dumped
      ? "The copy holds what was in it when the copy started. What's written after that isn't carried, so stop what writes to it first."
      : `Kiln can't dump ${engineNames[database.engine]}, so its data isn't carried: the copy starts empty.`
    const login =
      "The copy has its own password and hostname. What uses it needs both."
    const members = database.members.length
    return {
      duplicate: [data, login],
      migrate: [
        data,
        ...(members > 0
          ? [
              `${members === 1 ? "1 thing connects" : `${members} things connect`} to it on ${relay.name}. ${members === 1 ? "It stays" : "They stay"} there and can't reach the copy on another Relay.`,
            ]
          : []),
        login,
      ],
    }
  },
}

const engineNames: Record<DatabaseEngine, string> = {
  mariadb: "MariaDB",
  mysql: "MySQL",
  postgres: "PostgreSQL",
  redis: "Redis",
  valkey: "Valkey",
}

// One database as its Relay has it, by its ID alone.
async function relayDatabase(
  relay: PersistedRelay,
  id: string,
  subject: string | undefined
): Promise<RelayManagedDatabase | null> {
  const { relayRpc } = await import("@/lib/relay-connection")
  const [item] = z
    .array(
      z.object({ database: relayManagedDatabaseSchema.optional() }).loose()
    )
    .parse(
      await relayRpc(
        relay,
        "database.list",
        { requests: [{ id, view: "detail" }] },
        30_000,
        subject
      )
    )
  return item?.database ?? null
}

// What Hearth keeps of a database that its copy is made with.
const databaseRecord = Effect.fnUntraced(function* (side: {
  readonly id: string
  readonly relayId: string
}) {
  const database = yield* Database
  const [row] = yield* database.queryRows<
    RowDataPacket & {
      brick_source: string
      database_name: string
      engine: DatabaseEngine
      username: string
    }
  >(
    "resourceMigrations.database",
    `SELECT brick_source, database_name, engine, username
       FROM ${databaseTable("database")}
      WHERE relay_id = ? AND database_id = ? LIMIT 1`,
    [side.relayId, side.id]
  )
  return row ?? null
})
