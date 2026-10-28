import type { RowDataPacket } from "mysql2/promise"
import { relayDatabaseNetworkImportResultSchema } from "@workspace/contracts"
import { exclusive } from "@workspace/operations"
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
import { quickOperation, runOperation } from "@/operations/run"

// Relays keep every database connection, Apps' too. Apps' used to be kept
// in their configs (`databaseIds`); Hearth hands those to each Relay once,
// then drops them from the configs. Every step is safe to repeat, so a
// crash anywhere only means the next attempt does it again:
//
// 1. Until the Relay acknowledges the handover, the configs keep the field,
//    and the Relay adds what it's sent to what it has, leaving out Apps and
//    databases deleted since. Nothing can change an App's connections on
//    that Relay meanwhile: App network changes and deploys hand over first.
// 2. Its acknowledgement is recorded in MySQL. From then on nothing reads
//    the field, and the handover never runs again for that Relay.
// 3. The configs are rewritten without the field, and that's recorded too.
//
// Configs are encrypted, so a MySQL migration can't rewrite them, and it
// would run before any Relay could acknowledge anything.

const IMPORT_BATCH = 100

declare global {
  var kilnDatabaseConnectionImports: Set<string> | undefined
}

// Relays this process has seen finished, so the check costs nothing after.
const finished = (globalThis.kilnDatabaseConnectionImports ??= new Set())

// One handover per Relay at a time, across every Hearth process.
const handover = quickOperation<string>({
  kind: "apps.databaseConnections.import",
  locks: (relayId) => [exclusive(`database-connections:${relayId}`)],
  version: 1,
})

interface ImportRow extends RowDataPacket {
  configs_cleared_at: number | null
}

const importTable = () => databaseTable("relay_database_connection_import")

const handOver = Effect.fn("apps.databaseConnections.import")(function* (
  relay: PersistedRelay
) {
  const database = yield* Database
  const [state] = yield* database.queryRows<ImportRow>(
    "database_connection_import_state",
    `SELECT configs_cleared_at FROM ${importTable()} WHERE relay_id = ?`,
    [relay.id]
  )
  if (!state) {
    const apps = yield* listLegacyAppDatabaseIdsEffect(relay.id)
    yield* Effect.annotateCurrentSpan({
      "relay.id": relay.id,
      "app.count": apps.length,
    })
    for (let start = 0; start < apps.length; start += IMPORT_BATCH) {
      const { relayRpc } = yield* promiseEffect(
        () => import("@/lib/relay-connection")
      )
      relayDatabaseNetworkImportResultSchema.parse(
        yield* promiseEffect(() =>
          relayRpc(
            relay,
            "database.network.import",
            { apps: apps.slice(start, start + IMPORT_BATCH) },
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
  }
  if (state?.configs_cleared_at == null) {
    yield* clearLegacyAppDatabaseIdsEffect(relay.id)
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "database_connection_import_cleared",
      `UPDATE ${importTable()} SET configs_cleared_at = ? WHERE relay_id = ?`,
      [now, relay.id]
    )
  }
})

/**
 * Hands the Relay its Apps' database connections from their configs, if it
 * hasn't had them yet. Anything that changes an App's connections on a
 * Relay, or deploys an App there, does this first.
 */
export const ensureAppDatabaseConnectionsImportedEffect = (
  relay: PersistedRelay
) =>
  Effect.suspend(() =>
    finished.has(relay.id)
      ? Effect.void
      : runOperation(handover, relay.id, handOver(relay)).pipe(
          Effect.tap(() => Effect.sync(() => finished.add(relay.id)))
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
 * changes, so it waits, and says so, until the Relay is resumed.
 */
export async function importAppDatabaseConnectionsOnConnect(
  relayId: string
): Promise<"done" | "paused"> {
  if (finished.has(relayId)) return "done"
  const relay = await loadPersistedRelay(relayId)
  if (!relay) return "done"
  if (!relay.enabled) return "paused"
  await ensureAppDatabaseConnectionsImported(relay)
  return "done"
}
