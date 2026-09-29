import { createHash, randomUUID } from "node:crypto"

import { relayCatalogSchema } from "@workspace/contracts"
import type { RelayCatalog } from "@workspace/contracts"
import { Clock, Effect, Result } from "effect"
import type { RowDataPacket } from "mysql2/promise"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

export const PERSONAL_CATALOG_LIMIT = 10

interface CatalogRow extends RowDataPacket {
  id: string
  owner_email: string | null
  owner_name: string | null
  owner_user_id: string
  published_at: number | null
  published_by: string | null
  revision_sha: string | null
  revision_url: string | null
  snapshot: unknown
  snapshot_sha256: string
  source: string
  updated_at: number
  visibility: "community" | "personal"
}

export interface BrickCatalogRecord {
  id: string
  ownerEmail: string | null
  ownerName: string | null
  ownerUserId: string
  publishedAt: string | null
  publishedBy: string | null
  revisionSha: string | null
  revisionUrl: string | null
  snapshot: RelayCatalog | null
  snapshotSha256: string
  source: string
  statusError: string | null
  updatedAt: string
  visibility: "community" | "personal"
}

export const listBrickCatalogsEffect = Effect.fn("brickCatalogs.list")(
  function* (userId: string, includeAll: boolean) {
    const database = yield* Database
    const rows = yield* database.queryRows<CatalogRow>(
      "brickCatalogs.list",
      `SELECT catalog.id, catalog.owner_user_id, catalog.source,
              catalog.snapshot, catalog.snapshot_sha256,
              catalog.revision_sha, catalog.revision_url,
              catalog.visibility, catalog.published_by,
              catalog.published_at, catalog.updated_at,
              auth_user.name AS owner_name,
              auth_user.email AS owner_email
         FROM ${databaseTable("brick_catalog")} catalog
         LEFT JOIN ${databaseTable("user")} auth_user
           ON auth_user.id = catalog.owner_user_id
        ${includeAll ? "" : "WHERE catalog.visibility = 'community' OR catalog.owner_user_id = ?"}
        ORDER BY catalog.visibility = 'community' DESC,
                 catalog.published_at DESC,
                 catalog.updated_at DESC,
                 catalog.id ASC`,
      includeAll ? [] : [userId]
    )
    return yield* decodeCatalogRows(rows)
  }
)

export const getBrickCatalogEffect = Effect.fn("brickCatalogs.get")(function* (
  catalogId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<CatalogRow>(
    "brickCatalogs.get",
    `SELECT catalog.id, catalog.owner_user_id, catalog.source,
              catalog.snapshot, catalog.snapshot_sha256,
              catalog.revision_sha, catalog.revision_url,
              catalog.visibility, catalog.published_by,
              catalog.published_at, catalog.updated_at,
              auth_user.name AS owner_name,
              auth_user.email AS owner_email
         FROM ${databaseTable("brick_catalog")} catalog
         LEFT JOIN ${databaseTable("user")} auth_user
           ON auth_user.id = catalog.owner_user_id
        WHERE catalog.id = ?
        LIMIT 1`,
    [catalogId]
  )
  return (yield* decodeCatalogRows(rows))[0] ?? null
})

export const saveBrickCatalogEffect = Effect.fn("brickCatalogs.save")(
  function* (input: {
    ownerUserId: string
    revisionSha: string | null
    revisionUrl: string | null
    snapshot: RelayCatalog
    snapshotSha256: string
    source: string
  }) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    const sourceHash = createHash("sha256").update(input.source).digest("hex")
    const id = randomUUID()
    return yield* database.transaction("brickCatalogs.save", (transaction) =>
      Effect.gen(function* () {
        yield* transaction.queryRows<RowDataPacket & { id: string }>(
          `SELECT id FROM ${databaseTable("user")}
            WHERE id = ? LIMIT 1 FOR UPDATE`,
          [input.ownerUserId]
        )
        // Production sessions lock their persisted user row to serialize the
        // per-account limit. The development bypass is intentionally virtual,
        // so an absent row must not prevent its local catalog from being saved.
        const existing = yield* transaction.queryRows<CatalogRow>(
          `SELECT catalog.id, catalog.owner_user_id, catalog.source,
                  catalog.snapshot, catalog.snapshot_sha256,
                  catalog.revision_sha, catalog.revision_url,
                  catalog.visibility, catalog.published_by,
                  catalog.published_at, catalog.updated_at,
                  NULL AS owner_name, NULL AS owner_email
             FROM ${databaseTable("brick_catalog")} catalog
            WHERE catalog.owner_user_id = ? AND catalog.source_hash = ?
            LIMIT 1 FOR UPDATE`,
          [input.ownerUserId, sourceHash]
        )
        const decodedCurrent = existing[0]
          ? decodeCatalogRow(existing[0])
          : null
        const current = decodedCurrent?.record
        if (current?.visibility === "community") {
          return yield* Effect.fail(
            new Error("Unpublish this catalog before replacing its snapshot")
          )
        }
        if (!current) {
          const counts = yield* transaction.queryRows<
            RowDataPacket & { total: number }
          >(
            `SELECT COUNT(*) AS total
               FROM ${databaseTable("brick_catalog")}
              WHERE owner_user_id = ?`,
            [input.ownerUserId]
          )
          if ((counts[0]?.total ?? 0) >= PERSONAL_CATALOG_LIMIT) {
            return yield* Effect.fail(
              new Error(
                `Each account can save up to ${PERSONAL_CATALOG_LIMIT} catalogs`
              )
            )
          }
        }
        yield* transaction.execute(
          `INSERT INTO ${databaseTable("brick_catalog")}
             (id, owner_user_id, source_hash, source, snapshot,
              snapshot_sha256, revision_sha, revision_url, created_at,
              updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             snapshot = VALUES(snapshot),
             snapshot_sha256 = VALUES(snapshot_sha256),
             revision_sha = VALUES(revision_sha),
             revision_url = VALUES(revision_url),
             updated_at = VALUES(updated_at)`,
          [
            id,
            input.ownerUserId,
            sourceHash,
            input.source,
            JSON.stringify(input.snapshot),
            input.snapshotSha256,
            input.revisionSha,
            input.revisionUrl,
            now,
            now,
          ]
        )
        return current?.id ?? id
      })
    )
  }
)

export const setBrickCatalogVisibilityEffect = Effect.fn(
  "brickCatalogs.setVisibility"
)(function* (input: {
  catalogId: string
  community: boolean
  publishedBy: string
}) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const result = yield* database.execute(
    "brickCatalogs.setVisibility",
    `UPDATE ${databaseTable("brick_catalog")}
        SET visibility = ?,
            published_by = ?,
            published_at = ?,
            updated_at = ?
      WHERE id = ?`,
    input.community
      ? ["community", input.publishedBy, now, now, input.catalogId]
      : ["personal", null, null, now, input.catalogId]
  )
  return result.affectedRows > 0
})

export const deleteBrickCatalogEffect = Effect.fn("brickCatalogs.delete")(
  function* (catalogId: string) {
    const database = yield* Database
    const result = yield* database.execute(
      "brickCatalogs.delete",
      `DELETE FROM ${databaseTable("brick_catalog")} WHERE id = ?`,
      [catalogId]
    )
    return result.affectedRows > 0
  }
)

function decodeCatalogRows(rows: ReadonlyArray<CatalogRow>) {
  return Effect.gen(function* () {
    const records: Array<BrickCatalogRecord> = []
    for (const row of rows) {
      const decoded = decodeCatalogRow(row)
      if (decoded.success) {
        records.push(decoded.record)
      } else {
        yield* Effect.logWarning(
          "Loaded invalid Brick catalog snapshot",
          decoded.error
        ).pipe(
          Effect.annotateLogs({
            "kiln.catalog_id": row.id,
            "kiln.catalog_owner_user_id": row.owner_user_id,
          })
        )
        records.push(decoded.record)
      }
    }
    return records
  })
}

function decodeCatalogRow(row: CatalogRow) {
  const snapshot = relayCatalogSchema.safeParse(decodeJson(row.snapshot))
  const record = {
    id: row.id,
    ownerEmail: row.owner_email,
    ownerName: row.owner_name,
    ownerUserId: row.owner_user_id,
    publishedAt:
      row.published_at === null
        ? null
        : new Date(row.published_at).toISOString(),
    publishedBy: row.published_by,
    revisionSha: row.revision_sha,
    revisionUrl: row.revision_url,
    snapshot: snapshot.success ? snapshot.data : null,
    snapshotSha256: row.snapshot_sha256,
    source: row.source,
    statusError: snapshot.success ? null : "Stored catalog snapshot is invalid",
    updatedAt: new Date(row.updated_at).toISOString(),
    visibility: row.visibility,
  } satisfies BrickCatalogRecord
  if (!snapshot.success) {
    return { error: snapshot.error, record, success: false } as const
  }
  return {
    record,
    success: true,
  } as const
}

function decodeJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  return Result.getOrElse(
    Result.try(() => JSON.parse(value) as unknown),
    () => null
  )
}
