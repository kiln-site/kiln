import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schema, Semaphore } from "effect"

import { Database } from "@/effect/database"
import {
  fetchKilnReleasePageEffect,
  kilnStableReleaseAliasesEffect,
  type PublicKilnRelease,
} from "@/effect/github-releases"
import { databaseTable } from "@/lib/database-config"
import { kilnGitRepository } from "@/lib/environment"
import { parseReleaseNotes, type ReleaseChange } from "@/lib/release-notes"
import { isKilnReleaseVersion, orderKilnReleases } from "@/lib/release-version"

// Unauthenticated GitHub requests share 60 an hour per IP, and a 304 still
// counts, so Hearth keeps every release it has seen and asks GitHub only
// for the newest page, at most this often.
const checkIntervalMs = 5 * 60_000
const githubPageSize = 100
const recentReleaseCount = 100
// Pages GitHub may have grown by since the last check before Hearth stops
// catching up and leaves the rest to history backfill.
const maxCatchUpPages = 5

const feedSettingId = "00000000-0000-4000-8000-000000000003"
const feedSettingKey = "kiln.releaseFeed"

const FeedState = Schema.Struct({
  checkedAt: Schema.Number,
  // The next GitHub page holding releases older than any Hearth has, or null
  // once Hearth has every release back to the first.
  historyPage: Schema.NullOr(Schema.Number),
  repository: Schema.String,
})
type FeedState = typeof FeedState.Type
const decodeFeedStateJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(FeedState)
)
const decodeFeedState = Schema.decodeUnknownOption(FeedState)

const ReleaseAliases = Schema.Array(Schema.String)
const decodeAliasesJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(ReleaseAliases)
)
const decodeAliases = Schema.decodeUnknownOption(ReleaseAliases)

// One sync or backfill at a time, so concurrent requests share its result
// instead of each asking GitHub.
const feedLock = Semaphore.makeUnsafe(1)

interface ReleaseRow extends RowDataPacket {
  aliases: unknown
  channel: "nightly" | "stable"
  manifest_url: string
  name: string
  notes: string | null
  published_at: number | string
  tag: string
  url: string
  version: string
}

export type ChangelogRelease = {
  aliases: ReadonlyArray<string>
  changes: Array<ReleaseChange>
  channel: "nightly" | "stable"
  hiddenCount: number
  name: string
  publishedAt: string | null
  tag: string
  url: string
  version: string
}

export type ReleaseHistoryCursor = {
  publishedAt: number
  tag: string
}

export type ReleaseHistoryPage = {
  nextCursor: ReleaseHistoryCursor | null
  releases: Array<ChangelogRelease>
}

/**
 * The newest Kiln releases, from Hearth's copy of the feed after checking
 * GitHub for newer ones when the last check is old enough.
 */
export const listKilnReleasesEffect = Effect.fn("releases.listRecent")(
  function* () {
    yield* syncReleaseFeed
    const rows = yield* selectReleases(null, recentReleaseCount)
    return orderKilnReleases(rows.map(publicRelease))
  }
)

/**
 * One page of release history older than `cursor`, newest first. Hearth
 * fetches older pages from GitHub only when someone reaches the end of the
 * releases it already has.
 */
export const releaseHistoryPageEffect = Effect.fn("releases.historyPage")(
  function* (cursor: ReleaseHistoryCursor | null, limit: number) {
    let state = yield* syncReleaseFeed
    let rows = yield* selectReleases(cursor, limit + 1)
    if (rows.length <= limit && state.historyPage !== null) {
      state = yield* feedLock.withPermits(1)(backfillReleaseHistory)
      rows = yield* selectReleases(cursor, limit + 1)
    }
    const releases = rows.slice(0, limit)
    const last = releases.at(-1)
    const more = rows.length > limit || state.historyPage !== null
    return {
      nextCursor: more
        ? last
          ? { publishedAt: Number(last.published_at), tag: last.tag }
          : cursor
        : null,
      releases: releases.map(changelogRelease),
    } satisfies ReleaseHistoryPage
  }
)

/**
 * Remembers the version each Panel and Relay runs and returns the one each
 * ran before it, keyed like the observations. Versions that aren't Kiln
 * releases, like development builds, aren't recorded.
 */
export const recordComponentVersionsEffect = Effect.fn(
  "releases.recordComponentVersions"
)(function* (observed: ReadonlyArray<{ key: string; version: string | null }>) {
  const known = observed.filter(
    (item): item is { key: string; version: string } =>
      isKilnReleaseVersion(item.version)
  )
  if (known.length === 0) return {}
  const database = yield* Database
  const table = databaseTable("system_component_version")
  const rows = yield* database.queryRows<
    RowDataPacket & {
      previous_version: string | null
      target_key: string
      version: string
    }
  >(
    "releases.loadComponentVersions",
    `SELECT target_key, version, previous_version FROM ${table}
      WHERE target_key IN (${known.map(() => "?").join(", ")})`,
    known.map(({ key }) => key)
  )
  const stored = new Map(rows.map((row) => [row.target_key, row]))
  const now = yield* Clock.currentTimeMillis
  const previous: Record<string, string> = {}
  for (const { key, version } of known) {
    const row = stored.get(key)
    if (row && row.version === version) {
      if (row.previous_version) previous[key] = row.previous_version
      continue
    }
    if (row) previous[key] = row.version
    yield* database.execute(
      "releases.saveComponentVersion",
      `INSERT INTO ${table} (target_key, version, previous_version, changed_at)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE version = VALUES(version),
                               previous_version = VALUES(previous_version),
                               changed_at = VALUES(changed_at)`,
      [key, version, row?.version ?? null, now]
    )
  }
  return previous
})

const syncReleaseFeed = feedLock.withPermits(1)(
  Effect.gen(function* () {
    const repository = kilnGitRepository()
    const now = yield* Clock.currentTimeMillis
    const stored = yield* loadFeedState
    const current = stored?.repository === repository ? stored : null
    if (current && now - current.checkedAt < checkIntervalMs) return current

    const database = yield* Database
    if (!current) {
      // A different repository is a different release history.
      yield* database.execute(
        "releases.clear",
        `DELETE FROM ${databaseTable("system_release")}`
      )
    }
    const checked = yield* catchUpWithGitHub(current).pipe(
      Effect.catch((error) =>
        // Serve what Hearth has, and wait out the interval before asking
        // again rather than spending the rate limit on retries.
        current
          ? Effect.logWarning(
              "Could not check GitHub for Kiln releases",
              error
            ).pipe(Effect.as(current.historyPage))
          : Effect.fail(error)
      )
    )
    const next: FeedState = {
      checkedAt: now,
      historyPage: checked,
      repository,
    }
    yield* saveFeedState(next)
    return next
  })
)

const catchUpWithGitHub = Effect.fnUntraced(function* (
  current: FeedState | null
) {
  for (let page = 1; page <= maxCatchUpPages; page += 1) {
    const { hasNextPage, releases } = yield* fetchKilnReleasePageEffect(
      page,
      githubPageSize
    )
    if (page === 1) yield* removeWithdrawnReleases(releases)
    const added = yield* saveReleases(releases)
    // A fresh copy starts from the newest page and backfills on demand.
    if (!current) return hasNextPage ? 2 : null
    if (added < releases.length || !hasNextPage) break
  }
  return current?.historyPage ?? null
})

const backfillReleaseHistory = Effect.gen(function* () {
  const state = yield* loadFeedState
  if (!state || state.historyPage === null) return state ?? emptyState()
  // New releases push older ones to later pages, so this page may repeat
  // some Hearth has, but it never skips one.
  const { hasNextPage, releases } = yield* fetchKilnReleasePageEffect(
    state.historyPage,
    githubPageSize
  )
  yield* saveReleases(releases)
  const next: FeedState = {
    ...state,
    historyPage: hasNextPage ? state.historyPage + 1 : null,
  }
  yield* saveFeedState(next)
  return next
})

function emptyState(): FeedState {
  return { checkedAt: 0, historyPage: null, repository: kilnGitRepository() }
}

// A release pulled from GitHub, say a broken nightly, must stop being
// offered. The newest page covers everything published after its oldest
// entry, so anything newer that it doesn't list is gone.
const removeWithdrawnReleases = Effect.fnUntraced(function* (
  newest: ReadonlyArray<PublicKilnRelease>
) {
  const oldest = newest.at(-1)
  if (!oldest) return
  const database = yield* Database
  yield* database.execute(
    "releases.removeWithdrawn",
    `DELETE FROM ${databaseTable("system_release")}
      WHERE published_at > ? AND tag NOT IN (${newest.map(() => "?").join(", ")})`,
    [publishedAtMillis(oldest.publishedAt), ...newest.map(({ tag }) => tag)]
  )
})

// Saves a page of releases and returns how many Hearth didn't have.
const saveReleases = Effect.fnUntraced(function* (
  releases: ReadonlyArray<PublicKilnRelease>
) {
  if (releases.length === 0) return 0
  const database = yield* Database
  const table = databaseTable("system_release")
  const existing = yield* database.queryRows<RowDataPacket & { tag: string }>(
    "releases.loadTags",
    `SELECT tag FROM ${table} WHERE tag IN (${releases.map(() => "?").join(", ")})`,
    releases.map(({ tag }) => tag)
  )
  const known = new Set(existing.map(({ tag }) => tag))
  const added = releases.filter(({ tag }) => !known.has(tag))
  for (const release of added) {
    const aliases =
      release.channel === "stable"
        ? yield* kilnStableReleaseAliasesEffect(release).pipe(
            Effect.catch(() => Effect.succeed(release.aliases))
          )
        : release.aliases
    yield* database.execute(
      "releases.save",
      `INSERT INTO ${table}
         (tag, version, name, channel, aliases, notes, url, manifest_url, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE name = VALUES(name), notes = VALUES(notes)`,
      [
        release.tag,
        release.version,
        release.name,
        release.channel,
        JSON.stringify(aliases),
        release.notes,
        release.url,
        release.manifestUrl,
        publishedAtMillis(release.publishedAt),
      ]
    )
  }
  return added.length
})

const selectReleases = Effect.fnUntraced(function* (
  cursor: ReleaseHistoryCursor | null,
  limit: number
) {
  const database = yield* Database
  return yield* database.queryRows<ReleaseRow>(
    "releases.list",
    `SELECT tag, version, name, channel, aliases, notes, url, manifest_url, published_at
       FROM ${databaseTable("system_release")}
      ${cursor ? "WHERE (published_at, tag) < (?, ?)" : ""}
      ORDER BY published_at DESC, tag DESC
      LIMIT ?`,
    cursor ? [cursor.publishedAt, cursor.tag, limit] : [limit]
  )
})

const loadFeedState = Effect.gen(function* () {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { setting_value: unknown }
  >(
    "releases.loadFeedState",
    `SELECT setting_value FROM ${databaseTable("setting")}
      WHERE id = ? AND user_id IS NULL AND setting_key = ?
      LIMIT 1`,
    [feedSettingId, feedSettingKey]
  )
  const value = rows[0]?.setting_value
  return (
    typeof value === "string"
      ? decodeFeedStateJson(value)
      : decodeFeedState(value)
  ).pipe(Option.getOrNull)
})

const saveFeedState = Effect.fnUntraced(function* (state: FeedState) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "releases.saveFeedState",
    `INSERT INTO ${databaseTable("setting")}
       (id, user_id, setting_key, setting_value, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_at = VALUES(updated_at)`,
    [feedSettingId, feedSettingKey, JSON.stringify(state), now, now]
  )
})

function publicRelease(row: ReleaseRow): PublicKilnRelease {
  return {
    aliases: rowAliases(row.aliases),
    channel: row.channel,
    manifestUrl: row.manifest_url,
    name: row.name,
    notes: row.notes,
    publishedAt: publishedAtIso(row.published_at),
    tag: row.tag,
    url: row.url,
    version: row.version,
  }
}

function changelogRelease(row: ReleaseRow): ChangelogRelease {
  const { changes, hiddenCount } = parseReleaseNotes(row.notes)
  return {
    aliases: rowAliases(row.aliases),
    changes,
    channel: row.channel,
    hiddenCount,
    name: row.name,
    publishedAt: publishedAtIso(row.published_at),
    tag: row.tag,
    url: row.url,
    version: row.version,
  }
}

function rowAliases(value: unknown): ReadonlyArray<string> {
  return (
    typeof value === "string" ? decodeAliasesJson(value) : decodeAliases(value)
  ).pipe(Option.getOrElse(() => []))
}

function publishedAtMillis(publishedAt: string | null): number {
  const time = publishedAt ? Date.parse(publishedAt) : Number.NaN
  return Number.isFinite(time) ? time : 0
}

function publishedAtIso(value: number | string): string | null {
  const time = Number(value)
  return time > 0 ? new Date(time).toISOString() : null
}
