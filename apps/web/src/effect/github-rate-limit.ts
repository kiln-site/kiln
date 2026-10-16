import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema, Semaphore } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

/**
 * What GitHub said is left of the requests Kiln may make to it in the
 * current window, and when the window resets. Unauthenticated, it's 60 an
 * hour per IP, shared by checking for releases and starting updates, which
 * reads the release's manifest.
 */
export type GitHubRateLimit = {
  remaining: number
  resetAt: number
}

/**
 * What GitHub's responses said, recorded by every request to its API: the
 * window's limit, and until when GitHub refused requests, as a secondary
 * limit does for a while without using up the window.
 */
export type GitHubRateLimitObservation = {
  limit: GitHubRateLimit | null
  refusedUntil: number | null
}

const GitHubRateLimitSchema = Schema.Struct({
  remaining: Schema.Number,
  resetAt: Schema.Number,
})
const ObservationSchema = Schema.Struct({
  limit: Schema.NullOr(GitHubRateLimitSchema),
  refusedUntil: Schema.NullOr(Schema.Number),
})
const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ObservationSchema)
)
const decode = Schema.decodeUnknownOption(ObservationSchema)

const settingId = "00000000-0000-4000-8000-000000000004"
const settingKey = "kiln.githubRateLimit"

// Requests answer in any order, so each records what it saw against what's
// recorded, one at a time.
const recordLock = Semaphore.makeUnsafe(1)

/**
 * When Kiln may spend GitHub's requests on anything but updates again, or
 * null if it may now: after a refusal ends, and once fewer than `reserve`
 * are left, after the window resets.
 */
export function gitHubWaitUntil(
  observed: GitHubRateLimitObservation | null,
  now: number,
  reserve: number
): number | null {
  const refused =
    observed?.refusedUntil != null && observed.refusedUntil > now
      ? observed.refusedUntil
      : null
  const limit = observed?.limit
  const spent =
    limit && limit.remaining <= reserve && now < limit.resetAt
      ? limit.resetAt
      : null
  return refused === null ? spent : Math.max(refused, spent ?? 0)
}

export const loadGitHubRateLimitEffect = Effect.fnUntraced(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { setting_value: unknown }
  >(
    "github.loadRateLimit",
    `SELECT setting_value FROM ${databaseTable("setting")}
      WHERE id = ? AND user_id IS NULL AND setting_key = ?
      LIMIT 1`,
    [settingId, settingKey]
  )
  const value = rows[0]?.setting_value
  return (typeof value === "string" ? decodeJson(value) : decode(value)).pipe(
    Option.getOrNull
  )
})

/** Records what a GitHub response said, merged with what's recorded. */
export const recordGitHubRateLimitEffect = (
  observed: GitHubRateLimitObservation
) =>
  recordLock.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const stored = yield* loadGitHubRateLimitEffect()
      yield* saveGitHubRateLimitEffect({
        limit: mergeLimit(stored?.limit ?? null, observed.limit, now),
        // A refusal holds until it ends, the later of two included.
        refusedUntil: laterActive(
          stored?.refusedUntil ?? null,
          observed.refusedUntil,
          now
        ),
      })
    })
  )

function mergeLimit(
  stored: GitHubRateLimit | null,
  next: GitHubRateLimit | null,
  now: number
): GitHubRateLimit | null {
  if (!next) return stored
  if (!stored || now >= stored.resetAt || next.resetAt > stored.resetAt) {
    return next
  }
  // Within one window what's left only goes down, so an answer arriving
  // late can't raise it.
  return next.resetAt === stored.resetAt && next.remaining < stored.remaining
    ? next
    : stored
}

function laterActive(
  stored: number | null,
  next: number | null,
  now: number
): number | null {
  const active = [stored, next].filter(
    (until): until is number => until !== null && until > now
  )
  return active.length > 0 ? Math.max(...active) : null
}

const saveGitHubRateLimitEffect = Effect.fnUntraced(function* (
  observed: GitHubRateLimitObservation
) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "github.saveRateLimit",
    `INSERT INTO ${databaseTable("setting")}
       (id, user_id, setting_key, setting_value, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_at = VALUES(updated_at)`,
    [settingId, settingKey, JSON.stringify(observed), now, now]
  )
})
