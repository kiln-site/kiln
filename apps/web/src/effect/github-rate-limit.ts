import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema, Semaphore } from "effect"

import { Database } from "@/effect/database"
import { databaseTable } from "@/lib/database-config"

/**
 * What GitHub last said is left of the requests Kiln may make to it, and
 * when its count resets. Unauthenticated, it's 60 an hour per IP, shared by
 * checking for releases and starting updates, which reads the release's
 * manifest. Every request to GitHub's API records it here.
 */
export type GitHubRateLimit = {
  remaining: number
  resetAt: number
}

const GitHubRateLimitSchema = Schema.Struct({
  remaining: Schema.Number,
  resetAt: Schema.Number,
})
const decodeJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(GitHubRateLimitSchema)
)
const decode = Schema.decodeUnknownOption(GitHubRateLimitSchema)

const settingId = "00000000-0000-4000-8000-000000000004"
const settingKey = "kiln.githubRateLimit"

// Requests answer in any order, so each records what it saw against what's
// recorded, one at a time.
const recordLock = Semaphore.makeUnsafe(1)

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

/** Records what a GitHub response said is left, or a refusal (none left). */
export const recordGitHubRateLimitEffect = (limit: GitHubRateLimit) =>
  recordLock.withPermits(1)(
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis
      const stored = yield* loadGitHubRateLimitEffect()
      const next = mergeRateLimit(stored, limit, now)
      if (next !== stored) yield* saveGitHubRateLimitEffect(next)
    })
  )

function mergeRateLimit(
  stored: GitHubRateLimit | null,
  next: GitHubRateLimit,
  now: number
): GitHubRateLimit {
  if (!stored || now >= stored.resetAt) return next
  // A refusal holds until it ends, the later of two refusals included,
  // whatever answers sent before it say.
  if (next.remaining === 0) {
    return stored.remaining === 0 && stored.resetAt > next.resetAt
      ? stored
      : next
  }
  if (stored.remaining === 0) return stored
  // Within one window what's left only goes down, so an answer arriving
  // late can't raise it.
  if (next.resetAt === stored.resetAt) {
    return next.remaining < stored.remaining ? next : stored
  }
  return next
}

const saveGitHubRateLimitEffect = Effect.fnUntraced(function* (
  limit: GitHubRateLimit
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
    [settingId, settingKey, JSON.stringify(limit), now, now]
  )
})
