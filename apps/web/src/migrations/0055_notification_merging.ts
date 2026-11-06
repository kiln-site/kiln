import { Clock, Effect, Option, Schema } from "effect"
import { SqlClient } from "effect/sql"

import type { Migration } from "@/effect/migrations"
import { databaseTableName } from "@/lib/database-config"

// A deployment or Kiln update notification as Kiln wrote them before they
// merged, with only what merging reads.
const stored = Schema.Struct({
  previousName: Schema.optional(Schema.String),
  previousVersion: Schema.optional(Schema.String),
  resource: Schema.optional(
    Schema.Struct({ id: Schema.String, relayId: Schema.String })
  ),
  status: Schema.optional(Schema.String),
})
const decodeObject = Schema.decodeUnknownOption(stored)
const decodeString = Schema.decodeUnknownOption(Schema.fromJsonString(stored))

interface Row {
  createdAt: number | string
  data: unknown
  id: string
  kind: string
  readAt: number | string | null
  userId: string
}

// Notifications that merge: each App has one deployment notification, and
// each person one Kiln update. Each person's open ones become their newest,
// which adds up what the unread ones said and stays unread if any of them
// was. The rest are cleared. Nothing is pushed for it. Nothing changes for
// someone with one.
export const notificationMerging: Migration = {
  id: 55,
  name: "notification_merging",
  run: Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient
    const table = sql(databaseTableName("notification"))
    yield* sql.withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<Row>`
          SELECT id, user_id AS userId, kind, data, created_at AS createdAt,
                 read_at AS readAt
            FROM ${table}
           WHERE kind IN ('app.deployed', 'kiln.updated')
             AND dismissed_at IS NULL
           ORDER BY created_at DESC, id DESC
           FOR UPDATE
        `
        const threads = new Map<
          string,
          Array<{ data: typeof stored.Type; raw: object; row: Row }>
        >()
        for (const row of rows) {
          const raw: unknown =
            typeof row.data === "string" ? JSON.parse(row.data) : row.data
          const data = (
            typeof row.data === "string"
              ? decodeString(row.data)
              : decodeObject(row.data)
          ).pipe(Option.getOrNull)
          if (data === null) continue
          const key =
            row.kind === "kiln.updated"
              ? `${row.userId}:kiln`
              : `${row.userId}:${data.resource?.relayId}:${data.resource?.id}`
          const thread = threads.get(key) ?? []
          thread.push({ data, raw: raw as object, row })
          threads.set(key, thread)
        }
        const now = yield* Clock.currentTimeMillis
        const cleared: Array<string> = []
        for (const [newest, ...older] of threads.values()) {
          if (!newest || !older.length) continue
          cleared.push(...older.map(({ row }) => row.id))
          const unread = older.filter(({ row }) => row.readAt === null)
          const merged = [newest, ...unread]
          const failures = merged.filter(
            ({ data }) => data.status === "failed"
          ).length
          const oldest = unread.at(-1)?.data
          const data =
            newest.row.kind === "kiln.updated"
              ? {
                  ...newest.raw,
                  ...(oldest?.previousVersion && {
                    previousName: oldest.previousName,
                    previousVersion: oldest.previousVersion,
                  }),
                }
              : {
                  ...newest.raw,
                  ...(merged.length > 1 && { count: merged.length }),
                  ...(failures > 0 && { failures }),
                }
          yield* sql`
            UPDATE ${table}
               SET data = ${JSON.stringify(data)},
                   read_at = ${unread.length ? null : newest.row.readAt}
             WHERE id = ${newest.row.id}
          `
        }
        for (let start = 0; start < cleared.length; start += 500)
          yield* sql`
            UPDATE ${table}
               SET dismissed_at = ${now}, read_at = COALESCE(read_at, ${now}),
                   push_pending = NULL
             WHERE id IN ${sql.in(cleared.slice(start, start + 500))}
          `
      })
    )
  }),
}
