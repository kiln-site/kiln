import type { RowDataPacket } from "mysql2/promise"
import { Clock, Effect, Option, Schedule, Schema } from "effect"

import {
  compareKilnReleaseVersions,
  kilnGitRepositorySlug,
} from "@workspace/contracts"

import { Database } from "@/effect/database"
import { listKilnReleasesEffect } from "@/effect/github-releases"
import {
  notifyUsersEffect,
  platformAdminIdsEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { forkAppEffect } from "@/effect/runtime"
import { databaseTable } from "@/lib/database-config"
import { kilnGitRepository } from "@/lib/environment"
import { isKilnReleaseVersion, newerStableRelease } from "@/lib/release-version"

// A platform-wide setting row: Hearth's version when it last started.
const startedVersionSettingId = "00000000-0000-4000-8000-000000000002"
const startedVersionSettingKey = "hearth.startedVersion"

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
  const rows = yield* database.queryRows<
    RowDataPacket & { setting_value: unknown }
  >(
    "notifications.loadStartedVersion",
    `SELECT setting_value FROM ${databaseTable("setting")}
      WHERE id = ? AND user_id IS NULL AND setting_key = ?
      LIMIT 1`,
    [startedVersionSettingId, startedVersionSettingKey]
  )
  const previousVersion = startedVersionFromSetting(rows[0]?.setting_value)
  if (previousVersion === currentVersion) return

  const now = yield* Clock.currentTimeMillis
  yield* database
    .transaction("notifications.recordStartedVersion", () =>
      Effect.gen(function* () {
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
        if (
          !previousVersion ||
          compareKilnReleaseVersions(currentVersion, previousVersion) !== 1
        )
          return []
        const admins = yield* platformAdminIdsEffect()
        yield* notifyUsersEffect(admins, `kiln.updated:${currentVersion}`, {
          kind: "kiln.updated",
          previousVersion,
          url: releaseTagUrl(currentVersion),
          version: currentVersion,
        })
        return admins
      })
    )
    .pipe(
      Effect.tap((admins) =>
        Effect.sync(() => publishNotificationChange(admins))
      )
    )
})

/**
 * Tells platform admins about the newest stable Kiln release when it is newer
 * than this installation. Nightly builds ship several times a day, so they
 * stay in the Updates dialog. Each release is announced once per admin, and
 * admins added later still receive the pending one on the next check.
 */
export const notifyLatestKilnReleaseEffect = Effect.fn(
  "notifications.notifyLatestRelease"
)(function* (currentVersion: string) {
  if (!isKilnReleaseVersion(currentVersion)) return
  const latest = newerStableRelease(
    currentVersion,
    yield* listKilnReleasesEffect()
  )
  if (!latest) return
  const admins = yield* platformAdminIdsEffect()
  yield* notifyUsersEffect(admins, `kiln.release:${latest.version}`, {
    kind: "kiln.release",
    name: latest.name,
    url: latest.url,
    version: latest.version,
  })
  publishNotificationChange(admins)
})

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
