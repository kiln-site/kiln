import type { RowDataPacket } from "mysql2/promise"
import { relayDatabaseNetworkImportResultSchema } from "@workspace/contracts"
import { Clock, Effect } from "effect"

import { Database } from "@/effect/database"
import {
  clearLegacyAppDatabaseIdsEffect,
  listLegacyAppDatabaseIdsEffect,
} from "@/effect/managed-apps"
import { promiseEffect } from "@/effect/promise"
import { runAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { loadPersistedRelay, type PersistedRelay } from "@/lib/relay-registry"
import { serialized } from "@/operations/serialized"

// Relays keep every database connection, Apps' too. Apps' used to be kept
// in their configs (`databaseIds`); Hearth hands those to each Relay, then
// drops them from the configs. Every step is safe to repeat, so a crash
// anywhere only means the next attempt does it again:
//
// 1. Hearth sends the connections every config it can read still keeps. The
//    Relay adds those it doesn't have, leaving out Apps and databases
//    deleted since and any pair someone connected or disconnected on it, so
//    a repeat, or another Hearth's handover, overrules nobody.
// 2. Once the Relay answers, Hearth records that it acknowledged, and drops
//    the field from those configs, and only those.
// 3. A config Hearth can't read, as when the secret it was saved with is
//    gone, keeps its field, and the handover isn't complete: each later
//    attempt reads it again, and hands it over once it can. Such an App
//    can't deploy or change its connections meanwhile, since both read its
//    config first.
// 4. With every config read and cleared, the handover is complete, and
//    Hearth never reads the field for that Relay again.
//
// Configs are encrypted, so a MySQL migration can't rewrite them, and it
// would run before any Relay could acknowledge anything.

const IMPORT_BATCH = 100

declare global {
  var kilnDatabaseConnectionImports: Set<string> | undefined
}

// Relays whose handover this process has seen complete, so the check costs
// nothing after.
const finished = (globalThis.kilnDatabaseConnectionImports ??= new Set())

interface ImportRow extends RowDataPacket {
  configs_cleared_at: number | null
}

const importTable = () => databaseTable("relay_database_connection_import")

// Whether the handover is complete, and the Apps whose configs it couldn't
// read if not.
const handOver = Effect.fn("apps.databaseConnections.import")(function* (
  relay: PersistedRelay
) {
  const database = yield* Database
  const [state] = yield* database.queryRows<ImportRow>(
    "database_connection_import_state",
    `SELECT configs_cleared_at FROM ${importTable()} WHERE relay_id = ?`,
    [relay.id]
  )
  if (state?.configs_cleared_at != null) return { unreadable: [] }
  const { apps, unreadable } = yield* listLegacyAppDatabaseIdsEffect(relay.id)
  yield* Effect.annotateCurrentSpan({
    "relay.id": relay.id,
    "app.count": apps.length,
    "app.unreadable_count": unreadable.length,
  })
  const handed = apps.filter((app) => app.databaseIds.length > 0)
  for (let start = 0; start < handed.length; start += IMPORT_BATCH) {
    const { relayRpc } = yield* promiseEffect(
      () => import("@/lib/relay-connection")
    )
    relayDatabaseNetworkImportResultSchema.parse(
      yield* promiseEffect(() =>
        relayRpc(
          relay,
          "database.network.import",
          { apps: handed.slice(start, start + IMPORT_BATCH) },
          120_000
        )
      )
    )
  }
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "database_connection_import_acknowledge",
    `INSERT IGNORE INTO ${importTable()} (relay_id, acknowledged_at)
     VALUES (?, ?)`,
    [relay.id, now]
  )
  yield* clearLegacyAppDatabaseIdsEffect(
    relay.id,
    apps.map((app) => app.appId)
  )
  if (unreadable.length > 0) {
    yield* Effect.logWarning(
      "Some Apps' configs can't be read, so their database connections wait to be handed to their Relay",
      { appIds: unreadable, relayId: relay.id }
    )
    return { unreadable }
  }
  yield* database.execute(
    "database_connection_import_cleared",
    `UPDATE ${importTable()} SET configs_cleared_at = ? WHERE relay_id = ?`,
    [yield* Clock.currentTimeMillis, relay.id]
  )
  return { unreadable }
})

const handOverInLane = (relay: PersistedRelay) =>
  Effect.suspend(() =>
    finished.has(relay.id)
      ? Effect.succeed({ unreadable: [] as ReadonlyArray<string> })
      : // One handover per Relay at a time.
        serialized(
          "apps.databaseConnections.import",
          [`database-connections:${relay.id}`],
          handOver(relay)
        ).pipe(
          Effect.tap(({ unreadable }) =>
            Effect.sync(() => {
              if (unreadable.length === 0) finished.add(relay.id)
            })
          )
        )
  )

/**
 * Hands the Relay its Apps' database connections from their configs, if it
 * hasn't had them all yet. Anything that changes an App's connections on a
 * Relay, or deploys an App there, does this first, and fails with it.
 */
export const ensureAppDatabaseConnectionsImportedEffect = (
  relay: PersistedRelay
) =>
  handOverInLane(relay).pipe(
    Effect.asVoid,
    Effect.mapError(
      (cause) =>
        new Error(
          `Couldn't hand this Relay the databases its Apps connect to, which it needs first: ${cause instanceof Error ? cause.message : String(cause)}`,
          { cause }
        )
    )
  )

export function ensureAppDatabaseConnectionsImported(
  relay: PersistedRelay
): Promise<void> {
  return runAppEffect(
    "apps.databaseConnections.import",
    ensureAppDatabaseConnectionsImportedEffect(relay)
  )
}

/**
 * The handover when Hearth connects to a Relay. A paused Relay takes no
 * changes, so it waits, and says so, until the Relay is resumed. Configs it
 * can't read wait for the next connect, as after their secret is restored.
 */
export async function importAppDatabaseConnectionsOnConnect(
  relayId: string
): Promise<"done" | "paused"> {
  if (finished.has(relayId)) return "done"
  const relay = await loadPersistedRelay(relayId)
  if (!relay) return "done"
  if (!relay.enabled) return "paused"
  await runAppEffect("apps.databaseConnections.import", handOverInLane(relay))
  return "done"
}
