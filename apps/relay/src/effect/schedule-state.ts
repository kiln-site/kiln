import { Effect, Result } from "effect"
import type { SqlClient } from "effect/sql/SqlClient"
import { isSqlError } from "effect/sql/SqlError"
import { z } from "zod"

import {
  nextScheduleOccurrence,
  relayScheduleProjectionSchema,
  scheduleRunSchema,
  scheduleStableId,
  type RelayScheduleDeployment,
  type RelayScheduleProjection,
  type ScheduleRun,
} from "@workspace/contracts"

import { RelayStateError } from "./errors.js"

export const legacyScheduleStateSchema = z.strictObject({
  lastHeartbeatAt: z.number().int().nonnegative(),
  runs: z.array(scheduleRunSchema).max(1_000),
  schedules: z.array(
    relayScheduleProjectionSchema.safeExtend({
      nextRunAt: z.number().int().nonnegative().nullable(),
    })
  ),
  tombstones: z.record(z.string(), z.number().int().positive()),
  version: z.literal(1),
})

interface ScheduleRow {
  schedule_id: string
  revision: number
  next_run_at: number | null
  definition_json: string
}

interface RunRow {
  run_id: string
  schedule_id: string
  revision: number
  scheduled_at: number
  started_at: number
  finished_at: number | null
  status: ScheduleRun["status"]
  sequence_attempts_json: string
  target_runs_json: string
}

export interface ScheduleOccurrence {
  readonly definition: RelayScheduleProjection
  readonly run: ScheduleRun
  readonly scheduledAt: number
}

export type RelayScheduleState = ReturnType<typeof makeRelayScheduleState>

const historyLimit = 1_000
export const relayTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"

const deployment = (
  scheduleId: string,
  acknowledgedRevision: number,
  nextRunAt: number | null
): RelayScheduleDeployment => ({ scheduleId, acknowledgedRevision, nextRunAt })

const readDefinition = (row: ScheduleRow) =>
  relayScheduleProjectionSchema.parse(JSON.parse(row.definition_json))

const readRun = (row: RunRow) =>
  scheduleRunSchema.parse({
    id: row.run_id,
    scheduleId: row.schedule_id,
    revision: row.revision,
    scheduledAt: row.scheduled_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at ?? row.started_at,
    status: row.status,
    sequenceAttempts: JSON.parse(row.sequence_attempts_json),
    targetRuns: JSON.parse(row.target_runs_json),
  })

const sqlFailure = <A, E>(effect: Effect.Effect<A, E>) =>
  effect.pipe(
    Effect.catchDefect((cause) =>
      isSqlError(cause) ? Effect.fail(cause) : Effect.die(cause)
    )
  )

export function makeRelayScheduleState(sql: SqlClient) {
  const run = <A, E>(operation: string, effect: Effect.Effect<A, E>) =>
    sqlFailure(effect).pipe(
      Effect.mapError((cause) =>
        RelayStateError.make({ operation: `schedules.${operation}`, cause })
      ),
      Effect.withSpan(`relay.state.schedules.${operation}`)
    )
  const runValues = (record: ScheduleRun) => sql`
    (run_id, schedule_id, revision, scheduled_at, started_at, finished_at,
     status, sequence_attempts_json, target_runs_json)
    VALUES (${record.id}, ${record.scheduleId}, ${record.revision}, ${record.scheduledAt},
      ${record.startedAt}, ${record.status === "running" ? null : record.finishedAt},
      ${record.status}, ${JSON.stringify(record.sequenceAttempts)}, ${JSON.stringify(record.targetRuns)})`
  const insertRun = (record: ScheduleRun) =>
    sql`INSERT INTO relay_schedule_runs ${runValues(record)} ON CONFLICT DO NOTHING`.pipe(
      Effect.asVoid
    )
  const writeRun = (record: ScheduleRun) =>
    sql`
    INSERT INTO relay_schedule_runs ${runValues(record)}
    ON CONFLICT(run_id) DO UPDATE SET finished_at = excluded.finished_at,
      status = excluded.status, sequence_attempts_json = excluded.sequence_attempts_json,
      target_runs_json = excluded.target_runs_json
  `.pipe(Effect.asVoid)
  // History keeps the most recently finished runs, so a long run that ends
  // after newer ones still reports its result.
  const pruneRuns = () =>
    sql`
    DELETE FROM relay_schedule_runs WHERE run_id IN (
      SELECT run_id FROM relay_schedule_runs WHERE status <> 'running'
      ORDER BY finished_at DESC, run_id DESC LIMIT -1 OFFSET ${historyLimit}
    )
  `.pipe(Effect.asVoid)
  const claim = (
    row: ScheduleRow,
    occurrence: { definition: RelayScheduleProjection; nextRunAt: number },
    now: number,
    bootAt: number,
    relayId: string
  ) =>
    Effect.gen(function* () {
      const scheduledAt = row.next_run_at!
      // Occurrences that fell due while the Relay was down are recorded, not run.
      const missed = scheduledAt <= bootAt
      const record = scheduleRunSchema.parse({
        id: scheduleStableId(row.schedule_id, scheduledAt, relayId),
        scheduleId: row.schedule_id,
        revision: row.revision,
        scheduledAt,
        startedAt: now,
        finishedAt: now,
        status: missed ? "missed" : "running",
        targetRuns: [],
      })
      // An older manual run can already occupy this occurrence's timestamp.
      // Advance the cron without overwriting or re-executing its history.
      const inserted = yield* sql<{ run_id: string }>`
        INSERT INTO relay_schedule_runs
          (run_id, schedule_id, revision, scheduled_at, started_at, finished_at,
           status, sequence_attempts_json, target_runs_json)
        VALUES (${record.id}, ${record.scheduleId}, ${record.revision}, ${record.scheduledAt},
          ${record.startedAt}, ${missed ? record.finishedAt : null}, ${record.status}, '[]', '[]')
        ON CONFLICT DO NOTHING RETURNING run_id
      `
      yield* sql`UPDATE relay_schedules SET next_run_at = ${occurrence.nextRunAt} WHERE schedule_id = ${row.schedule_id}`
      return inserted.length
        ? { definition: occurrence.definition, run: record, scheduledAt }
        : null
    })

  return {
    nextRunAt: () =>
      run(
        "next_run_at",
        sql<{ next_run_at: number | null }>`
          SELECT MIN(next_run_at) AS next_run_at FROM relay_schedules
          WHERE enabled = 1 AND next_run_at IS NOT NULL
        `.pipe(Effect.map((rows) => rows[0]?.next_run_at ?? null))
      ),
    // Startup retires schedules.json after every import, so a file found at start
    // was written by an older Relay after a downgrade, or is the one an
    // interrupted start already imported. Either way it is at least as new as
    // SQLite: it wins ties, which carries same-revision credential refreshes,
    // and a newer revision or deletion here still wins.
    importLegacy: (state: z.infer<typeof legacyScheduleStateSchema>) =>
      run(
        "import_legacy",
        sql.withTransaction(
          Effect.gen(function* () {
            for (const schedule of state.schedules) {
              const { nextRunAt, ...definition } = schedule
              yield* sql`INSERT INTO relay_schedules
                  (schedule_id, revision, enabled, next_run_at, definition_json)
                SELECT ${schedule.id}, ${schedule.revision}, ${schedule.enabled ? 1 : 0}, ${nextRunAt}, ${JSON.stringify(definition)}
                WHERE NOT EXISTS (SELECT 1 FROM relay_schedule_tombstones
                  WHERE schedule_id = ${schedule.id} AND revision >= ${schedule.revision})
                ON CONFLICT(schedule_id) DO UPDATE SET revision = excluded.revision,
                  enabled = excluded.enabled, next_run_at = excluded.next_run_at,
                  definition_json = excluded.definition_json
                WHERE excluded.revision >= relay_schedules.revision`
              yield* sql`DELETE FROM relay_schedule_tombstones
                WHERE schedule_id = ${schedule.id} AND revision < ${schedule.revision}`
            }
            for (const [id, revision] of Object.entries(state.tombstones)) {
              yield* sql`DELETE FROM relay_schedules WHERE schedule_id = ${id} AND revision <= ${revision}`
              yield* sql`INSERT INTO relay_schedule_tombstones (schedule_id, revision)
                SELECT ${id}, ${revision}
                WHERE NOT EXISTS (SELECT 1 FROM relay_schedules WHERE schedule_id = ${id})
                ON CONFLICT(schedule_id) DO UPDATE SET revision = MAX(revision, excluded.revision)`
            }
            for (const record of state.runs) yield* insertRun(record)
            yield* pruneRuns()
          })
        )
      ),
    // Revisions only move forward. A stale apply or remove acknowledges the
    // newer revision this Relay already holds instead of failing.
    apply: (definition: RelayScheduleProjection, nextRunAt: number | null) =>
      run(
        "apply",
        sql.withTransaction(
          Effect.gen(function* () {
            const deleted = yield* sql<{
              revision: number
            }>`SELECT revision FROM relay_schedule_tombstones WHERE schedule_id = ${definition.id}`
            if (deleted[0] && deleted[0].revision >= definition.revision) {
              return deployment(definition.id, deleted[0].revision, null)
            }
            const current = yield* sql<ScheduleRow>`
              SELECT schedule_id, revision, next_run_at, definition_json
              FROM relay_schedules WHERE schedule_id = ${definition.id}`
            if (current[0] && current[0].revision > definition.revision) {
              return deployment(
                definition.id,
                current[0].revision,
                current[0].next_run_at
              )
            }
            yield* sql`INSERT INTO relay_schedules (schedule_id, revision, enabled, next_run_at, definition_json)
        VALUES (${definition.id}, ${definition.revision}, ${definition.enabled ? 1 : 0}, ${nextRunAt}, ${JSON.stringify(definition)})
        ON CONFLICT(schedule_id) DO UPDATE SET revision = excluded.revision, enabled = excluded.enabled,
          next_run_at = excluded.next_run_at, definition_json = excluded.definition_json`
            yield* sql`DELETE FROM relay_schedule_tombstones WHERE schedule_id = ${definition.id}`
            return deployment(definition.id, definition.revision, nextRunAt)
          })
        )
      ),
    remove: (input: { scheduleId: string; revision: number }) =>
      run(
        "remove",
        sql.withTransaction(
          Effect.gen(function* () {
            const current = yield* sql<ScheduleRow>`
              SELECT schedule_id, revision, next_run_at, definition_json
              FROM relay_schedules WHERE schedule_id = ${input.scheduleId}`
            if (current[0] && current[0].revision > input.revision) {
              return deployment(
                input.scheduleId,
                current[0].revision,
                current[0].next_run_at
              )
            }
            const deleted = yield* sql<{
              revision: number
            }>`SELECT revision FROM relay_schedule_tombstones WHERE schedule_id = ${input.scheduleId}`
            const revision = Math.max(input.revision, deleted[0]?.revision ?? 0)
            yield* sql`DELETE FROM relay_schedules WHERE schedule_id = ${input.scheduleId}`
            yield* sql`INSERT INTO relay_schedule_tombstones (schedule_id, revision) VALUES (${input.scheduleId}, ${revision})
        ON CONFLICT(schedule_id) DO UPDATE SET revision = excluded.revision`
            return deployment(input.scheduleId, revision, null)
          })
        )
      ),
    claimDue: (now: number, bootAt: number, relayId: string, limit: number) =>
      run(
        "claim_due",
        Effect.gen(function* () {
          const rows = yield* sql<ScheduleRow>`
            SELECT schedule_id, revision, next_run_at, definition_json
            FROM relay_schedules WHERE enabled = 1 AND next_run_at <= ${now}
            ORDER BY next_run_at, schedule_id LIMIT ${limit}`
          const occurrences: Array<ScheduleOccurrence> = []
          const failures: Array<unknown> = []
          // Claims commit one row at a time, so a later failure must not hide
          // the occurrences already claimed. Failed rows stay due for the next
          // attempt, and the caller backs off on the first failure.
          const attempt = <A, E>(effect: Effect.Effect<A, E>) =>
            sqlFailure(effect).pipe(
              Effect.result,
              Effect.tap((result) =>
                Effect.sync(() => {
                  if (Result.isFailure(result)) failures.push(result.failure)
                })
              )
            )
          for (const row of rows) {
            const occurrence = Result.try(() => {
              const definition = readDefinition(row)
              return {
                definition,
                nextRunAt: nextScheduleOccurrence(
                  definition.cron,
                  relayTimezone,
                  now
                ).getTime(),
              }
            })
            if (Result.isFailure(occurrence)) {
              // Drop an unusable local copy. Hearth sees the revision missing
              // and redeploys it, surfacing any error on that deployment.
              const dropped = yield* attempt(
                sql`DELETE FROM relay_schedules WHERE schedule_id = ${row.schedule_id}`
              )
              if (Result.isSuccess(dropped)) {
                yield* Effect.logWarning(
                  "Unreadable Relay schedule removed for redeployment",
                  { scheduleId: row.schedule_id, cause: occurrence.failure }
                )
              }
              continue
            }
            const claimed = yield* attempt(
              sql.withTransaction(
                claim(row, occurrence.success, now, bootAt, relayId)
              )
            )
            if (Result.isSuccess(claimed) && claimed.success) {
              occurrences.push(claimed.success)
            }
          }
          if (occurrences.some((item) => item.run.status === "missed")) {
            yield* attempt(pruneRuns())
          }
          return {
            occurrences,
            failure: failures.length ? { cause: failures[0] } : null,
            hasMore: rows.length === limit,
          }
        })
      ),
    runNow: (
      input: { scheduleId: string; revision: number },
      now: number,
      relayId: string
    ) =>
      run(
        "run_now",
        sql.withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<ScheduleRow>`
              SELECT schedule_id, revision, next_run_at, definition_json
              FROM relay_schedules WHERE schedule_id = ${input.scheduleId}`
            const row = rows[0]
            if (!row) {
              return { error: "Schedule is not deployed on this Relay" } as const
            }
            if (row.revision !== input.revision) {
              return { error: "Schedule deployment is out of date" } as const
            }
            const definition = readDefinition(row)
            const latest = yield* sql<{
              scheduled_at: number
            }>`SELECT scheduled_at FROM relay_schedule_runs
        WHERE schedule_id = ${input.scheduleId} ORDER BY scheduled_at DESC LIMIT 1`
            let scheduledAt = Math.max(now, (latest[0]?.scheduled_at ?? 0) + 1)
            if (scheduledAt === row.next_run_at) scheduledAt++
            const record = scheduleRunSchema.parse({
              id: scheduleStableId(row.schedule_id, scheduledAt, relayId),
              scheduleId: row.schedule_id,
              revision: row.revision,
              scheduledAt,
              startedAt: now,
              finishedAt: now,
              status: "running",
              targetRuns: [],
            })
            yield* writeRun(record)
            return { definition, run: record, scheduledAt }
          })
        )
      ),
    interruptRuns: (now: number) =>
      run(
        "interrupt_runs",
        sql`UPDATE relay_schedule_runs
      SET status = 'interrupted', finished_at = ${now} WHERE status = 'running'`.pipe(
          Effect.asVoid
        )
      ),
    completeRun: (record: ScheduleRun) =>
      run(
        "complete_run",
        sql.withTransaction(
          Effect.gen(function* () {
            yield* writeRun(record)
            yield* pruneRuns()
          })
        )
      ),
    overview: (scheduleIds?: ReadonlyArray<string>) =>
      run(
        "overview",
        sql.withTransaction(
          Effect.gen(function* () {
            const ids = scheduleIds ? JSON.stringify(scheduleIds) : null
            const schedules = yield* sql<
              Omit<ScheduleRow, "definition_json">
            >`SELECT schedule_id, revision, next_run_at FROM relay_schedules
        WHERE ${ids} IS NULL OR schedule_id IN (SELECT value FROM json_each(${ids}))`
            const rows = yield* sql<RunRow>`SELECT * FROM relay_schedule_runs
        WHERE ${ids} IS NULL OR schedule_id IN (SELECT value FROM json_each(${ids}))
        ORDER BY finished_at IS NOT NULL, finished_at DESC, run_id DESC
        LIMIT ${historyLimit}`
            const runs: Array<ScheduleRun> = []
            for (const row of rows) {
              const record = Result.try(() => readRun(row))
              if (Result.isSuccess(record)) runs.push(record.success)
              else
                yield* Effect.logWarning(
                  "Unreadable schedule history row skipped",
                  { scheduleId: row.schedule_id, runId: row.run_id }
                )
            }
            return {
              deployments: schedules.map((row) =>
                deployment(row.schedule_id, row.revision, row.next_run_at)
              ),
              runs,
            }
          })
        )
      ),
  }
}
