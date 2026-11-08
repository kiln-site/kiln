import { Effect, Predicate, Result } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import {
  isLegacyRelayId,
  isLegacyResourceId,
  type InstanceIdKind,
  type LegacyInstanceReference,
} from "@workspace/contracts"

import { RelayStateError } from "./errors.js"
import type { InstanceLegacyId } from "../instance-keys.js"

/**
 * The one-time move to 12-character instance IDs, as SQLite keeps it: the
 * old ID each migrated instance had (`relay_instance_legacy_ids`), the old
 * IDs the Relay's records name, and the rewrite of every record to the new
 * ones. The rest of the move is in `instance-id-migration.ts`.
 */
export interface RelayInstanceIdState {
  /** Every migrated instance's old ID. */
  readonly list: () => Effect.Effect<Array<InstanceLegacyId>, RelayStateError>
  /** Records old IDs, keeping any already recorded. */
  readonly save: (
    entries: ReadonlyArray<InstanceLegacyId>
  ) => Effect.Effect<void, RelayStateError>
  /**
   * The old IDs the Relay's records name where what they are is known:
   * its game servers', Apps', databases', and other Relays' (and their
   * game servers') a schedule or connection names.
   */
  readonly legacyReferences: (
    ownFingerprint: string
  ) => Effect.Effect<Array<LegacyInstanceReference>, RelayStateError>
  /**
   * Rewrites every text value of every table but those holding keys and
   * secrets with `rewrite`, records the old IDs, and marks the migration
   * done, all at once. Says how many rows changed.
   */
  readonly migrate: (input: {
    readonly entries: ReadonlyArray<InstanceLegacyId>
    readonly marker: string
    readonly rewrite: (table: string, column: string, value: string) => string
  }) => Effect.Effect<number, RelayStateError>
}

// Tables whose text is keys, signatures, hashes, or Hearth's own IDs, never
// an instance's, and the migration's own.
const UNTOUCHED_TABLES = new Set([
  "effect_sql_migrations",
  "relay_browser_file_replays",
  "relay_browser_issuer_generations",
  "relay_clients",
  "relay_instance_legacy_ids",
  "relay_invitations",
  "relay_operations",
  "relay_pause_holds",
])

export function makeRelayInstanceIdState(sql: SqlClient): RelayInstanceIdState {
  const run = <T>(operation: string, effect: Effect.Effect<T, unknown>) =>
    effect.pipe(
      Effect.mapError((cause) => RelayStateError.make({ operation, cause })),
      Effect.withSpan(`relay.state.instance_ids.${operation}`)
    )

  const insert = (entries: ReadonlyArray<InstanceLegacyId>) =>
    Effect.forEach(
      entries,
      (entry) => sql`
        INSERT INTO relay_instance_legacy_ids (id, kind, legacy_id)
        VALUES (${entry.id}, ${entry.kind}, ${entry.legacyId})
        ON CONFLICT DO NOTHING
      `,
      { discard: true }
    )

  const column = (query: string) =>
    sql
      .unsafe<{ value: string | null }>(query)
      .pipe(
        Effect.map((rows) =>
          rows.flatMap((row) =>
            typeof row.value === "string" ? [row.value] : []
          )
        )
      )

  return {
    list: () =>
      run(
        "list",
        sql<{ id: string; kind: InstanceIdKind; legacyId: string }>`
          SELECT id, kind, legacy_id AS legacyId
          FROM relay_instance_legacy_ids
        `.pipe(Effect.map((rows) => rows.map((row) => ({ ...row }))))
      ),
    save: (entries) => run("save", insert(entries)),
    legacyReferences: (ownFingerprint) =>
      run(
        "legacy_references",
        Effect.gen(function* () {
          const references: Array<LegacyInstanceReference> = []
          const add = (
            kind: "app" | "database" | "server",
            values: ReadonlyArray<string>
          ) => {
            for (const id of values) {
              if (!isLegacyResourceId(id)) continue
              references.push(
                kind === "server"
                  ? { id, kind, relayFingerprint: ownFingerprint }
                  : { id, kind }
              )
            }
          }
          // An App-owned volume's ID, `<App ID>/<key>`, names its App; any
          // other volume's is its own, which stays.
          const volumes = (values: ReadonlyArray<string>) =>
            add(
              "app",
              values.flatMap((value) =>
                value.includes("/") ? [value.split("/")[0]!] : []
              )
            )
          const relay = (values: ReadonlyArray<string>) => {
            for (const fingerprint of values)
              if (isLegacyRelayId(fingerprint))
                references.push({ fingerprint, kind: "relay" })
          }
          const owned = (prefix: string, values: ReadonlyArray<string>) =>
            values.flatMap((value) =>
              value.startsWith(prefix) ? [value.slice(prefix.length)] : []
            )
          const routes = yield* column(
            "SELECT instance_id AS value FROM relay_web_routes"
          )
          add("server", routes)
          add("app", owned("app:", routes))
          for (const table of [
            "relay_instance_names",
            "relay_pending_primary_ports",
            "relay_runtime_recovery",
            "relay_instance_lifecycle_events",
            "relay_pending_limits",
          ]) {
            add(
              "server",
              yield* column(`SELECT instance_id AS value FROM ${table}`)
            )
          }
          for (const [kind, jobKind] of [
            ["server", "server"],
            ["app", "app"],
            ["database", "database"],
          ] as const) {
            add(
              kind,
              yield* column(
                `SELECT instance_id AS value FROM relay_instance_provisioning_jobs WHERE kind = '${jobKind}'`
              )
            )
          }
          add(
            "server",
            yield* column(
              "SELECT scope_id AS value FROM relay_browser_authorization_floors WHERE scope_kind = 'instance'"
            )
          )
          for (const table of [
            "relay_database_connections",
            "relay_database_connection_choices",
          ]) {
            for (const [kind, memberKind] of [
              ["server", "instance"],
              ["app", "app"],
              ["database", "database"],
            ] as const) {
              add(
                kind,
                yield* column(
                  `SELECT member_id AS value FROM ${table} WHERE member_kind = '${memberKind}'`
                )
              )
            }
            add(
              "database",
              yield* column(`SELECT database_id AS value FROM ${table}`)
            )
          }
          relay(
            yield* column(
              "SELECT relay_id AS value FROM relay_database_connections"
            )
          )
          for (const [kind, table, field, kindColumn] of [
            ["app", "relay_disk_limits", "resource_id", "kind"],
            ["database", "relay_disk_limits", "resource_id", "kind"],
            ["app", "relay_resource_freezes", "resource_id", "kind"],
            ["database", "relay_resource_freezes", "resource_id", "kind"],
            ["app", "relay_docker_cleanups", "owner_id", "owner_kind"],
            ["database", "relay_docker_cleanups", "owner_id", "owner_kind"],
          ] as const) {
            add(
              kind,
              yield* column(
                `SELECT ${field} AS value FROM ${table} WHERE ${kindColumn} = '${kind}'`
              )
            )
          }
          add(
            "server",
            yield* column(
              "SELECT resource_id AS value FROM relay_resource_freezes WHERE kind = 'instance'"
            )
          )
          volumes(
            yield* column(
              "SELECT resource_id AS value FROM relay_resource_freezes WHERE kind = 'volume'"
            )
          )
          add(
            "server",
            yield* column(
              "SELECT owner_id AS value FROM relay_docker_cleanups WHERE owner_kind = 'instance'"
            )
          )
          volumes(
            yield* column(
              "SELECT volume_id AS value FROM relay_app_volume_references"
            )
          )
          for (const query of [
            "SELECT app_id AS value FROM relay_app_volume_references",
            "SELECT app_id AS value FROM relay_app_power_revisions",
            "SELECT app_id AS value FROM relay_app_deployment_images",
          ]) {
            add("app", yield* column(query))
          }
          for (const unresolved of yield* column(
            "SELECT unresolved_json AS value FROM relay_volume_reference_imports"
          )) {
            add("app", jsonArray(unresolved).filter(Predicate.isString))
          }
          const owners = yield* column(
            "SELECT owner AS value FROM relay_docker_images"
          )
          add("app", owned("app:", owners))
          add("database", owned("database:", owners))
          add("server", owned("instance:", owners))
          // Schedules name their targets with the Relay each is on, which
          // a game server's new ID depends on.
          for (const definition of yield* column(
            "SELECT definition_json AS value FROM relay_schedules"
          )) {
            for (const target of scheduleTargets(definition)) {
              relay([target.relayId])
              if (target.kind === "relay") relay([target.id])
              else if (target.kind === "instance") {
                if (
                  isLegacyResourceId(target.id) &&
                  isLegacyRelayId(target.relayId)
                )
                  references.push({
                    id: target.id,
                    kind: "server",
                    relayFingerprint: target.relayId,
                  })
              } else if (target.kind === "app" || target.kind === "database")
                add(target.kind, [target.id])
            }
          }
          for (const input of yield* column(
            "SELECT input_json AS value FROM relay_backup_tasks"
          )) {
            const target = backupTarget(input)
            if (!target) continue
            if (target.kind === "instance") add("server", [target.id])
            else if (target.kind === "app") add("app", [target.id])
            else if (target.kind === "volume") volumes([target.id])
            else if (target.kind === "database") add("database", [target.id])
          }
          return references
        })
      ),
    migrate: ({ entries, marker, rewrite }) =>
      run(
        "migrate",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* insert(entries)
            const tables = yield* sql<{ name: string }>`
              SELECT name FROM sqlite_master
              WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
            `
            let changed = 0
            for (const { name: table } of tables) {
              if (UNTOUCHED_TABLES.has(table)) continue
              const columns = (yield* sql<{ name: string; type: string }>`
                SELECT name, type FROM pragma_table_info(${table})
              `).filter((entry) => entry.type.toUpperCase() === "TEXT")
              if (columns.length === 0) continue
              const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`
              const rows = yield* sql.unsafe<Record<string, unknown>>(
                `SELECT rowid AS __rowid, ${columns.map((entry) => quoted(entry.name)).join(", ")} FROM ${quoted(table)}`
              )
              for (const row of rows) {
                const updates: Array<[string, string]> = []
                for (const { name } of columns) {
                  const value = row[name]
                  if (typeof value !== "string") continue
                  const rewritten = rewrite(table, name, value)
                  if (rewritten !== value) updates.push([name, rewritten])
                }
                if (updates.length === 0) continue
                // A row whose new key another already has gives way to it.
                yield* sql.unsafe(
                  `UPDATE OR REPLACE ${quoted(table)} SET ${updates.map(([name]) => `${quoted(name)} = ?`).join(", ")} WHERE rowid = ?`,
                  [...updates.map(([, value]) => value), row.__rowid]
                )
                changed += 1
              }
            }
            yield* sql`
              INSERT INTO relay_metadata (key, value)
              VALUES (${marker}, ${String(Date.now())})
              ON CONFLICT (key) DO UPDATE SET value = excluded.value
            `
            return changed
          })
        )
      ),
  }
}

// Parsed JSON, or null for anything unreadable, which names nothing.
function parsedJson(text: string): unknown {
  return Result.getOrElse(
    Result.try(() => JSON.parse(text) as unknown),
    () => null
  )
}

function jsonArray(text: string): Array<unknown> {
  const parsed = parsedJson(text)
  return Array.isArray(parsed) ? parsed : []
}

function scheduleTargets(
  definition: string
): Array<{ id: string; kind: string; relayId: string }> {
  const parsed = parsedJson(definition)
  const targets = Predicate.isObject(parsed)
    ? (parsed as { targets?: unknown }).targets
    : null
  return Array.isArray(targets)
    ? targets.flatMap((target: unknown) =>
        Predicate.isObject(target) &&
        typeof (target as Record<string, unknown>).id === "string" &&
        typeof (target as Record<string, unknown>).kind === "string" &&
        typeof (target as Record<string, unknown>).relayId === "string"
          ? [target as { id: string; kind: string; relayId: string }]
          : []
      )
    : []
}

function backupTarget(input: string): { id: string; kind: string } | null {
  const parsed = parsedJson(input)
  const target = Predicate.isObject(parsed)
    ? (parsed as { target?: unknown }).target
    : null
  return Predicate.isObject(target) &&
    typeof (target as Record<string, unknown>).id === "string" &&
    typeof (target as Record<string, unknown>).kind === "string"
    ? (target as { id: string; kind: string })
    : null
}
