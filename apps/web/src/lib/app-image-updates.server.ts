import {
  relayAppImageCheckResultsSchema,
  relayAppImageUpdatesV1Feature,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Schedule, Semaphore } from "effect"

import { latestAppDeploymentsEffect } from "@/effect/app-deployments"
import {
  autoUpdateAt,
  defaultAppImageUpdatePolicy,
  loadAppImageUpdatesEffect,
  recordAppImageCheckEffect,
  type AppImageUpdate,
} from "@/effect/app-image-updates"
import { ExternalServiceError } from "@/effect/errors"
import {
  listRelayAppConfigsEffect,
  loadAppConfigEffect,
} from "@/effect/managed-apps"
import {
  notifyUsersEffect,
  publishNotificationChange,
} from "@/effect/notifications"
import { forkAppWorker } from "@/effect/runtime"
import {
  enqueueAppDeployment,
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
  var kilnAppImageUpdateLocks: Map<string, Semaphore.Semaphore> | undefined
}

// When each Relay's apps were last checked. A restart checks them again.
const checked = (globalThis.kilnAppImageUpdateChecked ??= new Map<
  string,
  number
>())
// Each app's last failed check, reported once.
const failures = (globalThis.kilnAppImageUpdateFailures ??= new Map<
  string,
  string
>())
// One check per Relay at a time, so a check a person asks for and the
// hourly one don't ask its registries twice over.
const locks = (globalThis.kilnAppImageUpdateLocks ??= new Map<
  string,
  Semaphore.Semaphore
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
// of, unless it was skipped.
const announce = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  name: string,
  update: AppImageUpdate
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
    { relayId: relay.id, resourceId: relay.id, resourceType: "relay" },
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
    }
  )
  if (delivered > 0) publishNotificationChange(recipients)
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

// The Relay's image apps, or just `onlyAppId`, that check for updates:
// those whose config names a tag, not a digest, and haven't turned checks
// off.
const checkAppImagesEffect = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  onlyAppId?: string
) {
  const lock = locks.get(relay.id) ?? Semaphore.makeUnsafe(1)
  locks.set(relay.id, lock)
  yield* lock.withPermit(
    Effect.gen(function* () {
      const apps = (yield* listRelayAppConfigsEffect(relay.id)).filter(
        (app) =>
          (onlyAppId === undefined || app.appId === onlyAppId) &&
          app.config.sourceType === "image" &&
          app.config.image !== "" &&
          !app.config.image.includes("@")
      )
      const updates = yield* loadAppImageUpdatesEffect(
        apps.map((app) => app.appId)
      )
      const due = apps.filter(
        (app) =>
          (updates.get(app.appId)?.mode ?? defaultAppImageUpdatePolicy.mode) !==
          "off"
      )
      let changed = false
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
          Effect.map((response) =>
            relayAppImageCheckResultsSchema.parse(response)
          )
        )
        for (const result of results) {
          const app = batch.find((item) => item.appId === result.appId)
          // Mid-deployment, its outcome decides what runs.
          if (!app || result.status === "deploying") continue
          if (
            !(yield* stillChecked(
              relay.id,
              app.appId,
              app.config.image,
              askedAt
            ))
          ) {
            continue
          }
          const recorded = yield* recordAppImageCheckEffect(
            app.appId,
            app.config.image,
            result
          )
          changed ||= recorded.changed
          yield* reportFailure(relay.id, app.appId, recorded.update)
          if (recorded.newlySeen) {
            yield* announce(relay, app.name, recorded.update)
          }
          const at = autoUpdateAt(recorded.update)
          if (at !== null && at <= (yield* Clock.currentTimeMillis)) {
            enqueueAppDeployment(app.appId, relay.id, "update")
          }
        }
      }
      if (changed) publishAppDeploymentChange(relay.id)
    })
  )
})

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
 * Checks one app now, as when someone asks or it just deployed, and
 * answers what Kiln knows of its updates after.
 */
export const checkAppImageEffect = Effect.fn("Apps.imageUpdates.checkApp")(
  function* (relay: PersistedRelay, appId: string) {
    if (!checksImages(relay)) {
      return yield* Effect.fail(
        new Error("Update this Relay to check apps for image updates")
      )
    }
    yield* checkAppImagesEffect(relay, appId)
    const updates = yield* loadAppImageUpdatesEffect([appId])
    return updates.get(appId) ?? null
  }
)

/** Checks again after an image app deploys, so it shows what it runs. */
export function recheckAppImage(relayId: string, appId: string): void {
  forkAppWorker(
    Effect.gen(function* () {
      const relays = yield* listPersistedRelaysEffect()
      const relay = relays.find((item) => item.id === relayId)
      if (relay && checksImages(relay)) {
        yield* checkAppImagesEffect(relay, appId)
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
}
