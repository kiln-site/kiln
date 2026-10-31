import type { RowDataPacket } from "mysql2/promise"
import {
  relayAppImageCheckResultsSchema,
  relayAppImageUpdatesV1Feature,
  type AppConfig,
  type RelayAppImageCheckResult,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Schedule } from "effect"

import { latestAppDeploymentsEffect } from "@/effect/app-deployments"
import {
  autoUpdateAt,
  defaultAppImageUpdatePolicy,
  loadAppImageUpdatesEffect,
  recordAppImageCheckEffect,
  type AppImageUpdate,
} from "@/effect/app-image-updates"
import { Database } from "@/effect/database"
import { ExternalServiceError } from "@/effect/errors"
import {
  listRelayAppConfigsEffect,
  loadAppConfigEffect,
} from "@/effect/managed-apps"
import {
  notifyUsersEffect,
  openSourceKeysEffect,
  publishNotificationChange,
  resolveNotificationsEffect,
} from "@/effect/notifications"
import { forkAppWorker } from "@/effect/runtime"
import { outsideOperation } from "@/operations/current"
import { exclusive, resourceKey } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"
import { databaseTable } from "@/lib/database-config"
import {
  queueAppDeploymentEffect,
  publishAppDeploymentChange,
} from "@/lib/app-deployments.server"
import { relayConnectionFeatures, relayRpc } from "@/lib/relay-connection"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { resourceAudienceEffect } from "@/lib/resource-audience.server"

// Checks whether image apps' tags name newer images than the ones they
// run, an hour apart, by asking each Relay about all of its image apps at
// once. A new image tells everyone who can deploy the app, and deploys
// itself once it's been out as long as the app waits, if it's set to.

// How often Hearth looks for Relays due a check, and how far apart a
// Relay's checks are.
const sweepInterval = "5 minutes"
const checkIntervalMs = 60 * 60_000
// Apps per request, which the Relay checks four registries at a time.
const batchSize = 16
const checkTimeoutMs = 120_000

declare global {
  var kilnAppImageUpdateChecker: Fiber.Fiber<void> | undefined
  var kilnAppImageUpdateChecked: Map<string, number> | undefined
  var kilnAppImageUpdateFailures: Map<string, string> | undefined
  var kilnAppImageUpdateAnswered: Map<string, number> | undefined
}

// When each Relay's apps were last checked. A restart checks them again.
const checked = (globalThis.kilnAppImageUpdateChecked ??= new Map<
  string,
  number
>())
// When each app's newest recorded check was asked, so an older check that
// answers later doesn't replace it. Checks overlap only within a process.
const answeredAsked = (globalThis.kilnAppImageUpdateAnswered ??= new Map<
  string,
  number
>())
// Each app's last failed check, reported once.
const failures = (globalThis.kilnAppImageUpdateFailures ??= new Map<
  string,
  string
>())

// Whether a check's answer still says something: the app still names the
// image it asked about, and hasn't started deploying since, which may
// have changed what it runs.
const stillChecked = Effect.fnUntraced(function* (
  relayId: string,
  appId: string,
  image: string,
  askedAt: number
) {
  const [app, { latest }] = yield* Effect.all([
    loadAppConfigEffect(relayId, appId),
    latestAppDeploymentsEffect(appId),
  ])
  return (
    app?.config.sourceType === "image" &&
    app.config.image === image &&
    (latest === null ||
      (latest.status !== "running" && Date.parse(latest.startedAt) < askedAt))
  )
})

// Tells everyone who can deploy the app about an image they haven't heard
// of, unless it was skipped. Whoever asked for the check sees what it found.
const announce = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  name: string,
  update: AppImageUpdate,
  actorUserId: string | null
) {
  const digest = update.latestDigest
  if (
    update.mode === "off" ||
    digest === null ||
    update.image === null ||
    digest === update.skippedDigest
  ) {
    return
  }
  const recipients = yield* resourceAudienceEffect(
    { relayId: relay.id, resourceId: update.appId, resourceType: "app" },
    "app.manage"
  )
  const delivered = yield* notifyUsersEffect(
    recipients,
    `app.image-update:${update.appId}:${digest}`,
    {
      digest,
      image: update.image,
      kind: "app.image-update",
      resource: {
        id: update.appId,
        name,
        relayId: relay.id,
        type: "app",
      },
    },
    { actorUserId }
  )
  if (delivered > 0) publishNotificationChange(recipients)
})

function imageUpdateSourceKeyPrefix(appId: string) {
  return `app.image-update:${appId}:`
}

/**
 * Clears an app's update notifications that no longer offer anything: all
 * but the update Kiln has on offer now, read under the lock its checks take,
 * so a check that finished first can't clear a newer one another Hearth just
 * announced. `installedDigest` was just deployed, so it's no longer on offer;
 * `unchecked` means the app no longer checks for updates, so none is.
 */
export const resolveAppImageUpdateNotificationsEffect = Effect.fn(
  "Apps.imageUpdates.resolveNotifications"
)(function* (
  appId: string,
  settled: { installedDigest?: string; unchecked?: boolean } = {}
) {
  const database = yield* Database
  const prefix = imageUpdateSourceKeyPrefix(appId)
  const resolved = yield* database.transaction(
    "Apps.imageUpdates.resolveNotifications",
    () =>
      Effect.gen(function* () {
        const [offer] = yield* database.queryRows<
          RowDataPacket & {
            latest_digest: string | null
            mode: string
            skipped_digest: string | null
            state: string | null
          }
        >(
          "Apps.imageUpdates.offer",
          `SELECT state, mode, latest_digest, skipped_digest
             FROM ${databaseTable("app_image_update")}
            WHERE app_id = ?
              FOR UPDATE`,
          [appId]
        )
        const offered =
          !settled.unchecked &&
          offer?.state === "available" &&
          offer.mode !== "off" &&
          offer.latest_digest !== offer.skipped_digest &&
          offer.latest_digest !== settled.installedDigest
            ? offer.latest_digest
            : null
        const open = yield* openSourceKeysEffect("app.image-update", prefix)
        return yield* resolveNotificationsEffect(
          "app.image-update",
          open.filter((key) => key !== `${prefix}${offered}`)
        )
      })
  )
  publishNotificationChange(resolved)
})

// A registry that keeps failing fails every hour, so only a new failure
// reaches telemetry, until a check gets through.
const reportFailure = (
  relayId: string,
  appId: string,
  update: AppImageUpdate
) => {
  const key = `${relayId}:${appId}`
  if (update.checkError === null) {
    failures.delete(key)
    return Effect.void
  }
  if (failures.get(key) === update.checkError) return Effect.void
  failures.set(key, update.checkError)
  return Effect.logWarning("Could not check an app for image updates").pipe(
    Effect.annotateLogs({
      "app.id": appId,
      "error.message": update.checkError,
      "relay.id": relayId,
    })
  )
}

// What a Relay answered about one image app, and when it was asked.
export interface AppImageAnswer {
  readonly app: { appId: string; config: AppConfig; name: string }
  readonly askedAt: number
  // One mid-deployment isn't recorded: its outcome decides what runs.
  readonly result: Exclude<RelayAppImageCheckResult, { status: "deploying" }>
}

/**
 * Asks the Relay about its image apps, or just `onlyAppId`, that check for
 * updates: those whose config names a tag, not a digest, and haven't
 * turned checks off. No lane is held: registries may take a while. Each
 * batch's answers go to `answered` before the next is asked, so a batch
 * that fails later doesn't lose them. Reports whether `onlyAppId`, asked
 * about on its own, no longer checks.
 */
const askAppImagesEffect = Effect.fnUntraced(function* <E, R>(
  relay: PersistedRelay,
  onlyAppId: string | undefined,
  answered: (
    answers: ReadonlyArray<AppImageAnswer>
  ) => Effect.Effect<void, E, R>
) {
  const apps = (yield* listRelayAppConfigsEffect(relay.id)).filter(
    (app) =>
      (onlyAppId === undefined || app.appId === onlyAppId) &&
      app.config.sourceType === "image" &&
      app.config.image !== "" &&
      !app.config.image.includes("@")
  )
  const updates = yield* loadAppImageUpdatesEffect(apps.map((app) => app.appId))
  const due = apps.filter(
    (app) =>
      (updates.get(app.appId)?.mode ?? defaultAppImageUpdatePolicy.mode) !==
      "off"
  )
  for (let start = 0; start < due.length; start += batchSize) {
    const batch = due.slice(start, start + batchSize)
    const askedAt = yield* Clock.currentTimeMillis
    const results = yield* Effect.tryPromise({
      try: (signal) =>
        relayRpc(
          relay,
          "app.image.check",
          {
            apps: batch.map((app) => ({
              appId: app.appId,
              image: app.config.image,
            })),
          },
          checkTimeoutMs,
          undefined,
          signal
        ),
      catch: (cause) =>
        ExternalServiceError.make({
          cause,
          message: "Could not check the Relay's apps for image updates",
          service: "Relay",
        }),
    }).pipe(
      Effect.map((response) => relayAppImageCheckResultsSchema.parse(response))
    )
    const answers: Array<AppImageAnswer> = []
    for (const result of results) {
      const app = batch.find((item) => item.appId === result.appId)
      // Mid-deployment, its outcome decides what runs.
      if (app && result.status !== "deploying") {
        answers.push({ app, askedAt, result })
      }
    }
    yield* answered(answers)
  }
  return onlyAppId !== undefined && !due.some((app) => app.appId === onlyAppId)
})

/**
 * Records what a check found of an app, run holding the app: an answer
 * still about the image it names, newer than the last one recorded.
 * Reports whether it changed what Kiln knows.
 */
const recordAppImageAnswersEffect = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  appId: string,
  asked: { answers: ReadonlyArray<AppImageAnswer>; unchecked: boolean },
  actorUserId: string | null
) {
  // An app checked on its own that no longer checks, as one now pinned to a
  // digest or deployed from elsewhere, has no update on offer.
  if (asked.unchecked) {
    yield* resolveAppImageUpdateNotificationsEffect(appId, { unchecked: true })
  }
  let changed = false
  for (const { app, askedAt, result } of asked.answers) {
    if (app.appId !== appId) continue
    if (!(yield* stillChecked(relay.id, appId, app.config.image, askedAt))) {
      continue
    }
    // A check asked for after this one answered first.
    const appKey = `${relay.id}:${appId}`
    if ((answeredAsked.get(appKey) ?? 0) > askedAt) continue
    answeredAsked.set(appKey, askedAt)
    const recorded = yield* recordAppImageCheckEffect(
      appId,
      app.config.image,
      result
    )
    changed ||= recorded.changed
    yield* reportFailure(relay.id, appId, recorded.update)
    if (recorded.newlySeen) {
      yield* announce(relay, app.name, recorded.update, actorUserId)
    }
    // An update that's gone, skipped, or replaced by a newer image no longer
    // needs anyone's attention.
    yield* resolveAppImageUpdateNotificationsEffect(appId)
    const at = autoUpdateAt(recorded.update)
    if (at !== null && at <= (yield* Clock.currentTimeMillis)) {
      yield* queueAppDeploymentEffect(appId, relay.id, "update")
    }
  }
  return changed
})

// Kiln's own checks: ask with no lane held, then record each app's answer
// holding the app, so checks may overlap without one undoing another's.
const checkAppImagesEffect = (
  relay: PersistedRelay,
  onlyAppId?: string,
  actorUserId: string | null = null
) => {
  let changed = false
  const record = (
    appId: string,
    asked: { answers: ReadonlyArray<AppImageAnswer>; unchecked: boolean }
  ) =>
    inLanes(
      "app.image.check.record",
      "Checking this App's image",
      [exclusive(resourceKey("app", relay.id, appId))],
      recordAppImageAnswersEffect(relay, appId, asked, actorUserId)
    ).pipe(
      Effect.tap((appChanged) =>
        Effect.sync(() => {
          changed ||= appChanged
        })
      )
    )
  return Effect.gen(function* () {
    // Each batch is recorded before the next is asked for.
    const unchecked = yield* askAppImagesEffect(relay, onlyAppId, (answers) =>
      Effect.forEach(
        answers,
        (answer) =>
          record(answer.app.appId, { answers: [answer], unchecked: false }),
        { discard: true }
      )
    )
    if (unchecked && onlyAppId) {
      yield* record(onlyAppId, { answers: [], unchecked: true })
    }
  }).pipe(
    // What was recorded shows, even when a later batch failed.
    Effect.ensuring(
      Effect.sync(() => {
        if (changed) publishAppDeploymentChange(relay.id)
      })
    )
  )
}

export function startAppImageUpdateChecks(): void {
  const sweep = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis
    for (const relay of yield* listPersistedRelaysEffect()) {
      if (!checksImages(relay)) continue
      if (now - (checked.get(relay.id) ?? 0) < checkIntervalMs) continue
      checked.set(relay.id, now)
      yield* checkAppImagesEffect(relay).pipe(
        Effect.catchCause((cause) =>
          logException(Cause.squash(cause), {
            operation: "Apps.imageUpdates.check",
            attributes: { "relay.id": relay.id },
          })
        )
      )
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logException(Cause.squash(cause), {
        operation: "Apps.imageUpdates.sweep",
      })
    )
  )
  // The first sweep waits a little, so Relays have connected.
  globalThis.kilnAppImageUpdateChecker ??= forkAppWorker(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(sweep.pipe(Effect.repeat(Schedule.spaced(sweepInterval)))),
      Effect.asVoid
    )
  )
}

export function stopAppImageUpdateChecks(): Promise<void> {
  const checker = globalThis.kilnAppImageUpdateChecker
  globalThis.kilnAppImageUpdateChecker = undefined
  return checker
    ? Effect.runPromise(Fiber.interrupt(checker))
    : Promise.resolve()
}

if (import.meta.hot) import.meta.hot.dispose(() => stopAppImageUpdateChecks())

function checksImages(relay: PersistedRelay): boolean {
  return (
    relay.enabled &&
    relayConnectionFeatures(relay.id).has(relayAppImageUpdatesV1Feature)
  )
}

/**
 * Asks about one app now, as when someone asks, with no lane held; record
 * the answer holding the app (`recordCheckedAppImageEffect`).
 */
export const askAppImageEffect = Effect.fn("Apps.imageUpdates.askApp")(
  function* (relay: PersistedRelay, appId: string) {
    if (!checksImages(relay)) {
      return yield* Effect.fail(
        new Error("Update this Relay to check apps for image updates")
      )
    }
    const answers: Array<AppImageAnswer> = []
    const unchecked = yield* askAppImagesEffect(relay, appId, (batch) =>
      Effect.sync(() => {
        answers.push(...batch)
      })
    )
    return { answers, unchecked }
  }
)

/**
 * Records what asking about one app found, run holding the app, and answers
 * what Kiln knows of its updates after.
 */
export const recordCheckedAppImageEffect = Effect.fn(
  "Apps.imageUpdates.recordApp"
)(function* (
  relay: PersistedRelay,
  appId: string,
  asked: { answers: ReadonlyArray<AppImageAnswer>; unchecked: boolean },
  actorUserId: string | null
) {
  if (yield* recordAppImageAnswersEffect(relay, appId, asked, actorUserId)) {
    publishAppDeploymentChange(relay.id)
  }
  const updates = yield* loadAppImageUpdatesEffect([appId])
  return updates.get(appId) ?? null
})

/**
 * Checks again after an image app deploys, so it shows what it runs, or
 * after someone (`actorUserId`) changed how it updates.
 */
export function recheckAppImage(
  relayId: string,
  appId: string,
  actorUserId: string | null
): void {
  // Asked for by whatever changed the app, which doesn't wait for it.
  outsideOperation(() =>
    forkAppWorker(
      Effect.gen(function* () {
        const relays = yield* listPersistedRelaysEffect()
        const relay = relays.find((item) => item.id === relayId)
        if (relay && checksImages(relay)) {
          yield* checkAppImagesEffect(relay, appId, actorUserId)
        }
      }).pipe(
        Effect.catchCause((cause) =>
          logException(Cause.squash(cause), {
            operation: "Apps.imageUpdates.recheck",
            attributes: { "app.id": appId, "relay.id": relayId },
          })
        )
      )
    )
  )
}
