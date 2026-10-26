import { createHash } from "node:crypto"

import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Result } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"
import {
  iconOriginSchema,
  iconSubjectKey,
  type IconDetails,
  type IconIndex,
  type IconOrigin,
  type IconSubject,
} from "@/lib/icons"

type IconSource = "custom" | "detected"

interface IconIndexRow extends RowDataPacket {
  digest: string
  relay_id: string
  source: IconSource
  subject_id: string
  subject_kind: IconSubject["kind"]
}

interface IconImageRow extends RowDataPacket {
  content_type: string
  digest: string
  image: Buffer
}

interface IconDetailsRow extends RowDataPacket {
  checked_at: number | string
  digest: string | null
  origin: unknown
  source: IconSource
  updated_at: number | string
}

interface DetectionRow extends RowDataPacket {
  checked_at: number | string
  origin_version: string | null
  relay_id: string
  subject_id: string
}

export interface IconImage {
  readonly contentType: string
  readonly digest: string
  readonly image: Buffer
}

const table = () => databaseTable("icon")

function subjectKeys(subject: IconSubject): [string, string, string] {
  return [
    subject.kind,
    subject.kind === "user" ? "" : subject.relayId,
    subject.id,
  ]
}

function subjectFromRow(row: IconIndexRow): IconSubject {
  return row.subject_kind === "user"
    ? { kind: "user", id: row.subject_id }
    : { kind: row.subject_kind, relayId: row.relay_id, id: row.subject_id }
}

function iconDigest(image: Buffer): string {
  return createHash("sha256").update(image).digest("hex").slice(0, 16)
}

function parsedOrigin(value: unknown): IconOrigin | null {
  const raw = typeof value === "string" ? safeJson(value) : value
  const parsed = iconOriginSchema.safeParse(raw)
  return parsed.success ? parsed.data : null
}

function safeJson(value: string): unknown {
  return Result.try(() => JSON.parse(value) as unknown).pipe(
    Result.getOrElse(() => null)
  )
}

/**
 * Each subject's shown icon: its custom one, or else its detected one.
 * `include` decides which subjects the reader may see.
 */
export const listIconIndexEffect = Effect.fn("icons.index")(function* (
  include: (subject: IconSubject) => boolean
) {
  const database = yield* Database
  const rows = yield* database.queryRows<IconIndexRow>(
    "icons.index",
    `SELECT subject_kind, relay_id, subject_id, source, digest
       FROM ${table()}
      WHERE digest IS NOT NULL`
  )
  const index: Record<string, string> = {}
  for (const row of rows) {
    const subject = subjectFromRow(row)
    const key = iconSubjectKey(subject)
    if (row.source === "detected" && index[key]) continue
    if (!include(subject)) continue
    index[key] = row.digest
  }
  return index satisfies IconIndex["digests"]
})

/** The image shown for a subject, or null when it has none. */
export const getIconImageEffect = Effect.fn("icons.image")(function* (
  subject: IconSubject
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<IconImageRow>(
    "icons.image",
    `SELECT content_type, digest, image
       FROM ${table()}
      WHERE subject_kind = ? AND relay_id = ? AND subject_id = ?
        AND image IS NOT NULL
      ORDER BY source = 'custom' DESC
      LIMIT 1`,
    subjectKeys(subject)
  )
  return row
    ? ({
        contentType: row.content_type,
        digest: row.digest,
        image: row.image,
      } satisfies IconImage)
    : null
})

/**
 * The digest of a subject's shown icon, or null when it has none, so a
 * change can answer what browsers show next without another request.
 */
export const shownIconDigestEffect = Effect.fn("icons.shownDigest")(function* (
  subject: IconSubject
) {
  const database = yield* Database
  const [row] = yield* database.queryRows<IconImageRow>(
    "icons.shownDigest",
    `SELECT digest
       FROM ${table()}
      WHERE subject_kind = ? AND relay_id = ? AND subject_id = ?
        AND digest IS NOT NULL
      ORDER BY source = 'custom' DESC
      LIMIT 1`,
    subjectKeys(subject)
  )
  return row?.digest ?? null
})

/** Both of a subject's icons, without their images. */
export const getIconDetailsEffect = Effect.fn("icons.details")(function* (
  subject: IconSubject
) {
  const database = yield* Database
  const rows = yield* database.queryRows<IconDetailsRow>(
    "icons.details",
    `SELECT source, digest, origin, checked_at, updated_at
       FROM ${table()}
      WHERE subject_kind = ? AND relay_id = ? AND subject_id = ?`,
    subjectKeys(subject)
  )
  const custom = rows.find((row) => row.source === "custom")
  const detected = rows.find((row) => row.source === "detected")
  return {
    custom: custom
      ? {
          digest: custom.digest,
          origin: parsedOrigin(custom.origin),
          updatedAt: Number(custom.updated_at),
        }
      : null,
    detected: detected
      ? {
          checkedAt: Number(detected.checked_at),
          digest: detected.digest,
          origin: parsedOrigin(detected.origin),
        }
      : null,
  } satisfies IconDetails
})

/**
 * Saves a subject's custom or detected icon; a detected one without an
 * image records that nothing was found. Answers whether the shown image
 * may have changed.
 */
export const saveIconEffect = Effect.fn("icons.save")(function* (
  subject: IconSubject,
  source: IconSource,
  input: {
    readonly contentType: string | null
    readonly image: Buffer | null
    readonly origin: IconOrigin | null
    readonly originVersion?: string | null
  }
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  const digest = input.image ? iconDigest(input.image) : null
  const [previous] = yield* database.queryRows<IconDetailsRow>(
    "icons.save.previous",
    `SELECT source, digest, origin, checked_at, updated_at
       FROM ${table()}
      WHERE subject_kind = ? AND relay_id = ? AND subject_id = ? AND source = ?`,
    [...subjectKeys(subject), source]
  )
  yield* database.execute(
    "icons.save",
    `INSERT INTO ${table()}
       (subject_kind, relay_id, subject_id, source, content_type, image,
        digest, origin, origin_version, checked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       -- Before digest changes, which later assignments would see.
       updated_at = IF(digest <=> VALUES(digest), updated_at, VALUES(updated_at)),
       content_type = VALUES(content_type),
       image = VALUES(image),
       digest = VALUES(digest),
       origin = VALUES(origin),
       origin_version = VALUES(origin_version),
       checked_at = VALUES(checked_at)`,
    [
      ...subjectKeys(subject),
      source,
      input.contentType,
      input.image,
      digest,
      input.origin ? JSON.stringify(input.origin) : null,
      input.originVersion ?? null,
      now,
      now,
    ]
  )
  return (previous?.digest ?? null) !== digest
})

/** Marks a detected icon checked, unchanged, without rewriting its image. */
export const touchDetectedIconEffect = Effect.fn("icons.touchDetected")(
  function* (subject: IconSubject) {
    const database = yield* Database
    const now = yield* Clock.currentTimeMillis
    yield* database.execute(
      "icons.touchDetected",
      `UPDATE ${table()} SET checked_at = ?
        WHERE subject_kind = ? AND relay_id = ? AND subject_id = ?
          AND source = 'detected'`,
      [now, ...subjectKeys(subject)]
    )
  }
)

/** Removes a subject's custom icon, or every icon it has. */
export const removeIconsEffect = Effect.fn("icons.remove")(function* (
  subject: IconSubject,
  source?: IconSource
) {
  const database = yield* Database
  const result = yield* database.execute(
    "icons.remove",
    `DELETE FROM ${table()}
      WHERE subject_kind = ? AND relay_id = ? AND subject_id = ?${source ? " AND source = ?" : ""}`,
    source ? [...subjectKeys(subject), source] : subjectKeys(subject)
  )
  return result.affectedRows > 0
})

/** What Hearth last saw for each detected icon of a kind on a Relay. */
export const listDetectionsEffect = Effect.fn("icons.detections")(function* (
  kind: "app" | "server",
  relayId: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<DetectionRow>(
    "icons.detections",
    `SELECT relay_id, subject_id, origin_version, checked_at
       FROM ${table()}
      WHERE subject_kind = ? AND relay_id = ? AND source = 'detected'`,
    [kind, relayId]
  )
  return new Map(
    rows.map((row) => [
      row.subject_id,
      {
        checkedAt: Number(row.checked_at),
        originVersion: row.origin_version,
      },
    ])
  )
})

interface LinkedIconRow extends RowDataPacket {
  origin: unknown
  origin_version: string | null
  subject_id: string
  subject_kind: "app" | "server"
}

/**
 * The custom icons on a Relay that follow a file, with the version of the
 * file Hearth last copied.
 */
export const listLinkedIconsEffect = Effect.fn("icons.linked")(function* (
  relayId: string,
  subjectId?: string
) {
  const database = yield* Database
  const rows = yield* database.queryRows<LinkedIconRow>(
    "icons.linked",
    `SELECT subject_kind, subject_id, origin, origin_version
       FROM ${table()}
      WHERE relay_id = ? AND source = 'custom'
        AND subject_kind IN ('server', 'app')${subjectId ? " AND subject_id = ?" : ""}`,
    subjectId ? [relayId, subjectId] : [relayId]
  )
  return rows.flatMap((row) => {
    const origin = parsedOrigin(row.origin)
    return origin?.type === "file"
      ? [
          {
            id: row.subject_id,
            kind: row.subject_kind,
            origin,
            originVersion: row.origin_version,
          },
        ]
      : []
  })
})
