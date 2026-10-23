import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schedule, Schema } from "effect"

import {
  compareKilnReleaseVersions,
  kilnGitRepositorySlug,
} from "@workspace/contracts"

import { Database } from "@/effect/database"
import { listKilnReleasesEffect } from "@/effect/kiln-release-feed"
import {
  notifyUsersEffect,
  openSourceKeysEffect,
  platformAdminIdsEffect,
  publishNotificationChange,
  resolveNotificationsEffect,
} from "@/effect/notifications"
import { forkAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { kilnGitRepository } from "@/lib/environment"
import {
  findKilnRelease,
  isKilnReleaseVersion,
  newerStableRelease,
} from "@/lib/release-version"

// A platform-wide setting row: Hearth's version when it last started.
const startedVersionSettingId = "00000000-0000-4000-8000-000000000002"
const startedVersionSettingKey = "hearth.startedVersion"
// A platform-wide setting row: who last asked to update Hearth, and when.
const updateRequestSettingId = "e389dc11-f964-477f-80e7-ab48ba819ffa"
const updateRequestSettingKey = "hearth.updateRequest"
// How long after someone asks to update Hearth a newer start is theirs.
const updateRequestWindowMs = 6 * 60 * 60_000

function releaseTagUrl(version: string) {
  return `https://github.com/${kilnGitRepositorySlug(kilnGitRepository())}/releases/tag/v${version}`
}

/**
 * Records the version Hearth started with and, when it is newer than the last
 * one recorded, tells platform admins Kiln was updated. A fresh install only
 * records its version.
 */
export const recordStartedKilnVersionEffect = Effect.fn(
  "notifications.recordStartedVersion"
)(function* (currentVersion: string) {
  if (!isKilnReleaseVersion(currentVersion)) return
  const database = yield* Database
  const loadPreviousVersion = (lock: boolean) =>
    database
      .queryRows<RowDataPacket & { setting_value: unknown }>(
        "notifications.loadStartedVersion",
        `SELECT setting_value FROM ${databaseTable("setting")}
          WHERE id = ? AND user_id IS NULL AND setting_key = ?
          LIMIT 1${lock ? " FOR UPDATE" : ""}`,
        [startedVersionSettingId, startedVersionSettingKey]
      )
      .pipe(
        Effect.map(([row]) => startedVersionFromSetting(row?.setting_value))
      )
  const seen = yield* loadPreviousVersion(false)
  if (seen === currentVersion) return
  // Running the release that was on offer, or a newer one, answers it.
  const resolved = yield* clearReleaseNotificationsEffect(
    (version) => compareKilnReleaseVersions(version, currentVersion) !== 1
  )
  if (resolved.length) publishNotificationChange(resolved)

  const isUpdate = (previous: string | null): previous is string =>
    previous !== null &&
    compareKilnReleaseVersions(currentVersion, previous) === 1
  // Release names like "v0.1.0 Nightly #17" only exist on GitHub. Without
  // them the notification falls back to the version.
  const releases = isUpdate(seen)
    ? yield* listKilnReleasesEffect().pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Could not load Kiln release names", cause).pipe(
            Effect.as([])
          )
        )
      )
    : []
  // Several Hearths may start together: the row lock lets one record the
  // version, take who asked for the update, and tell the others.
  const admins = yield* database.transaction(
    "notifications.recordStartedVersion",
    () =>
      Effect.gen(function* () {
        const previousVersion = yield* loadPreviousVersion(true)
        if (previousVersion === currentVersion) return []
        const now = yield* Clock.currentTimeMillis
        yield* database.execute(
          "notifications.saveStartedVersion",
          `INSERT INTO ${databaseTable("setting")}
             (id, user_id, setting_key, setting_value, created_at, updated_at)
           VALUES (?, NULL, ?, ?, ?, ?)
           ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                                   updated_at = VALUES(updated_at)`,
          [
            startedVersionSettingId,
            startedVersionSettingKey,
            JSON.stringify({ version: currentVersion }),
            now,
            now,
          ]
        )
        if (!isUpdate(previousVersion)) return []
        const actorUserId = yield* takeUpdateRequesterEffect(now)
        const admins = yield* platformAdminIdsEffect()
        yield* notifyUsersEffect(
          admins,
          `kiln.updated:${currentVersion}`,
          {
            kind: "kiln.updated",
            name: findKilnRelease(releases, currentVersion)?.name,
            previousName: findKilnRelease(releases, previousVersion)?.name,
            previousVersion,
            url: releaseTagUrl(currentVersion),
            version: currentVersion,
          },
          { actorUserId }
        )
        return admins
      })
  )
  publishNotificationChange(admins)
})

/**
 * Tells platform admins about the newest stable Kiln release when it is newer
 * than this installation. Nightly builds ship several times a day, so they
 * stay in the Updates dialog. Each release is announced once per admin, and
 * admins added later still receive the pending one on the next check.
 *
 * Clearing is permanent, so an announcement is cleared only once it is known
 * to be stale: the installation runs that release or a newer one, or the feed
 * lists a newer stable release. One the feed no longer lists stays.
 *
 * An admin who checks for updates themselves (`actorUserId`) sees what the
 * check found, so they aren't told about it again.
 */
export const notifyLatestKilnReleaseEffect = Effect.fn(
  "notifications.notifyLatestRelease"
)(function* (currentVersion: string, actorUserId: string | null = null) {
  if (!isKilnReleaseVersion(currentVersion)) return
  const releases = yield* listKilnReleasesEffect()
  const latest = newerStableRelease(currentVersion, releases)
  const admins = yield* platformAdminIdsEffect()
  if (latest)
    yield* notifyUsersEffect(
      admins,
      releaseSourceKey(latest.version),
      {
        kind: "kiln.release",
        name: latest.name,
        url: latest.url,
        version: latest.version,
      },
      { actorUserId }
    )
  const stale = (version: string) =>
    version === currentVersion ||
    // Stable images keep the nightly version they were promoted from.
    releases.some(
      (release) =>
        release.version === version && release.aliases?.includes(currentVersion)
    ) ||
    compareKilnReleaseVersions(version, currentVersion) === -1 ||
    (latest !== null &&
      compareKilnReleaseVersions(version, latest.version) === -1)
  const cleared = yield* clearReleaseNotificationsEffect(stale)
  if (latest || cleared.length)
    publishNotificationChange([...admins, ...cleared])
})

const releaseSourceKeyPrefix = "kiln.release:"

function releaseSourceKey(version: string) {
  return `${releaseSourceKeyPrefix}${version}`
}

// Clears the announced releases whose version is `stale`, answering whose
// inboxes changed.
const clearReleaseNotificationsEffect = Effect.fnUntraced(function* (
  stale: (version: string) => boolean
) {
  const announced = yield* openSourceKeysEffect(
    "kiln.release",
    releaseSourceKeyPrefix
  )
  const keys = announced.filter((key) =>
    stale(key.slice(releaseSourceKeyPrefix.length))
  )
  return yield* resolveNotificationsEffect("kiln.release", keys)
})

/**
 * Remembers who asked to update Hearth, so the start that follows doesn't
 * tell them what they did.
 */
export const recordHearthUpdateRequestEffect = Effect.fn(
  "notifications.recordUpdateRequest"
)(function* (userId: string) {
  const database = yield* Database
  const now = yield* Clock.currentTimeMillis
  yield* database.execute(
    "notifications.saveUpdateRequest",
    `INSERT INTO ${databaseTable("setting")}
       (id, user_id, setting_key, setting_value, created_at, updated_at)
     VALUES (?, NULL, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE setting_value = VALUES(setting_value),
                             updated_at = VALUES(updated_at)`,
    [
      updateRequestSettingId,
      updateRequestSettingKey,
      JSON.stringify({ requestedAt: now, userId }),
      now,
      now,
    ]
  )
})

// Who asked to update Hearth recently enough that this start is theirs, if
// anyone. Each request answers one start. Call it inside the transaction
// that records the start.
const takeUpdateRequesterEffect = Effect.fnUntraced(function* (now: number) {
  const database = yield* Database
  const rows = yield* database.queryRows<
    RowDataPacket & { setting_value: unknown }
  >(
    "notifications.loadUpdateRequest",
    `SELECT setting_value FROM ${databaseTable("setting")}
      WHERE id = ? AND user_id IS NULL AND setting_key = ?
      LIMIT 1
      FOR UPDATE`,
    [updateRequestSettingId, updateRequestSettingKey]
  )
  if (!rows.length) return null
  yield* database.execute(
    "notifications.clearUpdateRequest",
    `DELETE FROM ${databaseTable("setting")} WHERE id = ?`,
    [updateRequestSettingId]
  )
  const value = rows[0]?.setting_value
  const request =
    typeof value === "string"
      ? decodeUpdateRequestJson(value)
      : decodeUpdateRequest(value)
  return request.pipe(
    Option.filter(
      ({ requestedAt }) => now - requestedAt <= updateRequestWindowMs
    ),
    Option.map(({ userId }) => userId),
    Option.getOrNull
  )
})

const UpdateRequestSetting = Schema.Struct({
  requestedAt: Schema.Number,
  userId: Schema.String,
})
const decodeUpdateRequestJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(UpdateRequestSetting)
)
const decodeUpdateRequest = Schema.decodeUnknownOption(UpdateRequestSetting)

const StartedVersionSetting = Schema.Struct({ version: Schema.String })
const decodeStartedVersionJson = Schema.decodeUnknownOption(
  Schema.fromJsonString(StartedVersionSetting)
)
const decodeStartedVersion = Schema.decodeUnknownOption(StartedVersionSetting)

function startedVersionFromSetting(value: unknown): string | null {
  const setting =
    typeof value === "string"
      ? decodeStartedVersionJson(value)
      : decodeStartedVersion(value)
  return setting.pipe(
    Option.map(({ version }) => version),
    Option.filter(isKilnReleaseVersion),
    Option.getOrNull
  )
}

let started = false
export function startKilnUpdateNotifications() {
  if (started) return
  started = true
  const currentVersion = import.meta.env.VITE_KILN_VERSION
  forkAppEffect(
    "notifications.kilnUpdates",
    recordStartedKilnVersionEffect(currentVersion).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not record the started Kiln version", cause)
      ),
      Effect.andThen(
        notifyLatestKilnReleaseEffect(currentVersion).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Could not check for Kiln releases", cause)
          ),
          Effect.repeat(Schedule.spaced("6 hours"))
        )
      )
    )
  )
}
