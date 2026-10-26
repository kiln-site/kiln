import { randomUUID } from "node:crypto"

import { Clock, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

const severities = ["negligible", "low", "medium", "high", "critical"] as const

// A vulnerability notification as Kiln wrote them before reports, one per
// resource, with only what a report keeps.
const vulnerabilityNotification = Schema.Struct({
  count: Schema.Number,
  knownExploited: Schema.Number,
  resource: Schema.Struct({
    id: Schema.String,
    name: Schema.String,
    relayId: Schema.String,
    type: Schema.Literals(["relay", "instance", "database", "app"]),
  }),
  severity: Schema.Literals(severities),
})
const decodeObject = Schema.decodeUnknownOption(vulnerabilityNotification)
const decodeString = Schema.decodeUnknownOption(
  Schema.fromJsonString(vulnerabilityNotification)
)

// Vulnerability reports: Kiln tells each person what it found in one
// notification that a newer one replaces, rather than one per resource. Each
// person's open vulnerability notifications become their first report,
// unread if any of them was, and are cleared. Nothing is pushed for it.
export const securityReports: Migration = {
  id: 31,
  name: "security_reports",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = sql(databaseTableName("notification"))
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          createdAt: number | string
          data: unknown
          id: string
          readAt: number | string | null
          userId: string
        }>`
          SELECT id, user_id AS userId, data, created_at AS createdAt,
                 read_at AS readAt
            FROM ${table}
           WHERE kind = 'security.vulnerabilities' AND dismissed_at IS NULL
           FOR UPDATE
        `
        if (!rows.length) return
        const reports = new Map<
          string,
          {
            count: number
            createdAt: number
            knownExploited: number
            readAt: number | null
            resources: Map<string, unknown>
            severity: number
            unread: boolean
          }
        >()
        for (const row of rows) {
          const data = (
            typeof row.data === "string"
              ? decodeString(row.data)
              : decodeObject(row.data)
          ).pipe(Option.getOrNull)
          if (data === null) continue
          const report = reports.get(row.userId) ?? {
            count: 0,
            createdAt: 0,
            knownExploited: 0,
            readAt: null,
            resources: new Map(),
            severity: 0,
            unread: false,
          }
          const { resource } = data
          report.count += data.count
          report.knownExploited += data.knownExploited
          report.severity = Math.max(
            report.severity,
            severities.indexOf(data.severity)
          )
          report.resources.set(
            `${resource.type}:${resource.relayId}:${resource.id}`,
            resource
          )
          report.createdAt = Math.max(report.createdAt, Number(row.createdAt))
          if (row.readAt === null) report.unread = true
          else report.readAt = Math.max(report.readAt ?? 0, Number(row.readAt))
          reports.set(row.userId, report)
        }
        for (const [userId, report] of reports) {
          yield* sql`
            INSERT INTO ${table}
              (id, user_id, kind, source_key, data, created_at, read_at)
            VALUES (${randomUUID()}, ${userId}, 'security.report',
                    ${`security.report:${randomUUID()}`},
                    ${JSON.stringify({
                      count: report.count,
                      knownExploited: report.knownExploited,
                      resources: [...report.resources.values()],
                      severity: severities[report.severity],
                    })},
                    ${report.createdAt},
                    ${report.unread ? null : report.readAt})
          `
        }
        const now = yield* Clock.currentTimeMillis
        yield* sql`
          UPDATE ${table}
             SET dismissed_at = ${now}, read_at = COALESCE(read_at, ${now}),
                 push_pending = NULL
           WHERE kind = 'security.vulnerabilities' AND dismissed_at IS NULL
        `
      })
    )
  }),
}
