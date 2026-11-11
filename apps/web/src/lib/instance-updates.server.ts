import type { RowDataPacket } from "mysql2/promise"
import {
  relayInstanceImageCheckResultsSchema,
  type RelayInstanceImageCheckResult,
} from "@workspace/contracts"
import { logException } from "@workspace/telemetry"
import { Cause, Clock, Effect, Fiber, Schedule, Semaphore } from "effect"

import { Database } from "@/effect/database"
import { ExternalServiceError } from "@/effect/errors"
import {
  autoBrickUpdateAt,
  autoUpdateAt,
  defaultInstanceUpdatePolicy,
  describesInstance,
  loadInstanceUpdatesEffect,
  offeredBrickRevision,
  recordInstanceBrickCheckEffect,
  recordInstanceImageCheckEffect,
  type InstanceUpdate,
  type InstanceUpdateKind,
} from "@/effect/instance-updates"
import {
  notifyUsersEffect,
  openSourceKeysEffect,
  publishNotificationChange,
  resolveNotificationsEffect,
} from "@/effect/notifications"
import { promiseEffect } from "@/effect/promise"
import { forkAppWorker } from "@/effect/runtime"
import { newestBrickRevision } from "@/lib/brick-revisions.server"
import { databaseTable } from "@/lib/database-config"
import {
  updatedKind,
  updatedKinds,
  type DueUpdate,
  type UpdateSubject,
} from "@/lib/instance-update-kinds.server"
import { relayRpc } from "@/lib/relay-connection"
import {
  listPersistedRelaysEffect,
  type PersistedRelay,
} from "@/lib/relay-registry"
import { notificationAudienceEffect } from "@/lib/resource-audience.server"
import { outsideOperation } from "@/operations/current"
import { resourceKey, shared } from "@/operations/lanes"
import { inLanes } from "@/operations/operation"

// Checks whether instances' image tags name newer images than the ones
// they run, an hour apart, by asking each Relay about each kind's
// instances at once. A new image tells everyone who can deploy the
// instance, and deploys itself once it's been out as long as the instance
// waits, if it's set to. What differs by kind (which instances check, and
// how one takes an update) is in `instance-update-kinds.server.ts`.

// How often Hearth looks for Relays due a check, and how far apart an
// instance's checks are.
const sweepInterval = "5 minutes"
const checkIntervalMs = 60 * 60_000
// Instances per request, which the Relay checks four registries at a time.
const batchSize = 16
const checkTimeoutMs = 120_000

declare global {
  var kilnInstanceUpdateChecker: Fiber.Fiber<void> | undefined
}

// Tells everyone who can deploy the instance about an image they haven't
// heard of, unless it was skipped. Whoever asked for the check sees what it
// found.
const announce = Effect.fnUntraced(function* (
  relay: PersistedRelay,
  name: string,
  update: InstanceUpdate,
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
  const { resourceType } = updatedKind(update.kind)
  const recipients = yield* notificationAudienceEffect(
    { relayId: relay.id, resourceId: update.instanceId, resourceType },
    // Whoever may take the update: deploying it is a deploy.
    "instance.deploy",
    "instance.image-update"
  )
  const delivered = yield* notifyUsersEffect(
    recipients,
    `${updateSourceKeyPrefix(update.instanceId)}${digest}`,
    {
      digest,
      image: update.image,
      kind: "instance.image-update",
      resource: {
        id: update.instanceId,
        name,
        relayId: relay.id,
        type: resourceType,
      },
    },
    { actorUserId }
  )
  if (delivered > 0) publishNotificationChange(recipients)
})

function updateSourceKeyPrefix(instanceId: string) {
  return `instance.image-update:${instanceId}:`
}

/**
 * Clears an instance's update notifications that no longer offer anything:
 * all but the update Kiln has on offer now, read with its row locked, so
 * two clearing at once agree. What a check found offers an update only
 * while it still describes the instance (`currentImageUpdate`).
 * `installedDigest` was just deployed, so it's no longer on offer;
 * `unchecked` means it no longer checks for updates, so none is.
 */
export const resolveInstanceUpdateNotificationsEffect = Effect.fn(
  "Instances.updates.resolveNotifications"
)(function* (
  kind: InstanceUpdateKind,
  relayId: string,
  instanceId: string,
  settled: { installedDigest?: string; unchecked?: boolean } = {}
) {
  const database = yield* Database
  const prefix = updateSourceKeyPrefix(instanceId)
  const adapter = updatedKind(kind)
  const [named, startedAt] = yield* Effect.all([
    adapter.namedImage(relayId, instanceId),
    adapter.latestDeploymentStartedAt(instanceId),
  ])
  const resolved = yield* database.transaction(
    "Instances.updates.resolveNotifications",
    () =>
      Effect.gen(function* () {
        const [offer] = yield* database.queryRows<
          RowDataPacket & {
            checked_at: number | string | null
            image: string | null
            latest_digest: string | null
            mode: string
            skipped_digest: string | null
            state: string | null
          }
        >(
          "Instances.updates.offer",
          `SELECT state, mode, image, checked_at, latest_digest, skipped_digest
             FROM ${databaseTable("instance_update")}
            WHERE instance_id = ?
              FOR UPDATE`,
          [instanceId]
        )
        const current =
          named !== undefined &&
          offer !== undefined &&
          describesInstance(
            {
              checkedAt:
                offer.checked_at === null ? null : Number(offer.checked_at),
              image: offer.image,
            },
            named,
            startedAt
          )
        const offered =
          !settled.unchecked &&
          current &&
          offer?.state === "available" &&
          offer.mode !== "off" &&
          offer.latest_digest !== offer.skipped_digest &&
          offer.latest_digest !== settled.installedDigest
            ? offer.latest_digest
            : null
        const open = yield* openSourceKeysEffect("instance.image-update", prefix)
        return yield* resolveNotificationsEffect(
          "instance.image-update",
          open.filter((key) => key !== `${prefix}${offered}`)
        )
      })
  )
  publishNotificationChange(resolved)
})

// What a Relay answered about one instance, and when it was asked.
export interface InstanceImageAnswer {
  readonly askedAt: number
  // One mid-deployment isn't recorded: its outcome decides what runs.
  readonly result: Exclude<
    RelayInstanceImageCheckResult,
    { status: "deploying" }
  >
  readonly subject: UpdateSubject
}

/**
 * Asks the Relay about a kind's instances, or just `onlyId`, that check for
 * updates: those whose image could move, and haven't turned checks off. No
 * lane is held: registries may take a while. Each batch's answers go to
 * `answered` before the next is asked, so a batch that fails later doesn't
 * lose them. Reports whether `onlyId`, asked about on its own, no longer
 * checks.
 */
const askImagesEffect = Effect.fnUntraced(function* <E, R>(
  kind: InstanceUpdateKind,
  relay: PersistedRelay,
  onlyId: string | undefined,
  answered: (
    answers: ReadonlyArray<InstanceImageAnswer>
  ) => Effect.Effect<void, E, R>
) {
  const adapter = updatedKind(kind)
  const now = yield* Clock.currentTimeMillis
  const subjects = (yield* adapter.subjects(relay)).filter(
    (subject) => onlyId === undefined || subject.id === onlyId
  )
  const updates = yield* loadInstanceUpdatesEffect(
    subjects.map((subject) => subject.id)
  )
  // Kiln's own checks ask about each instance once an hour, by when it was
  // last asked; one someone asks for, at once.
  const due = subjects.filter((subject) => {
    const update = updates.get(subject.id)
    if ((update?.mode ?? defaultInstanceUpdatePolicy.mode) === "off") {
      return false
    }
    const checkedAt = update?.checkedAt ?? null
    return (
      onlyId !== undefined ||
      checkedAt === null ||
      now - checkedAt >= checkIntervalMs
    )
  })
  for (let start = 0; start < due.length; start += batchSize) {
    const batch = due.slice(start, start + batchSize)
    const askedAt = yield* Clock.currentTimeMillis
    const results = yield* Effect.tryPromise({
      try: (signal) =>
        relayRpc(
          relay,
          "instance.image.check",
          {
            instances: batch.map((subject) => ({
              id: subject.id,
              ...(subject.image !== null && { image: subject.image }),
            })),
            kind: adapter.relayKind,
          },
          checkTimeoutMs,
          undefined,
          signal
        ),
      catch: (cause) =>
        ExternalServiceError.make({
          cause,
          message: "Could not check the Relay's instances for image updates",
          service: "Relay",
        }),
    }).pipe(
      Effect.map((response) =>
        relayInstanceImageCheckResultsSchema.parse(response)
      )
    )
    const answers: Array<InstanceImageAnswer> = []
    for (const result of results) {
      const subject = batch.find((item) => item.id === result.id)
      // Mid-deployment, its outcome decides what runs.
      if (subject && result.status !== "deploying") {
        answers.push({ askedAt, result, subject })
      }
    }
    yield* answered(answers)
  }
  return onlyId !== undefined && !due.some((subject) => subject.id === onlyId)
})

/**
 * Records what a check found of an instance, holding it shared so it isn't
 * recorded for one being deleted: one about an image it no longer names
 * says nothing about it, so isn't. Checks may overlap; what one recorded is
 * judged where it's used (`currentImageUpdate`). Reports whether it changed
 * what Kiln knows, and what has waited long enough for Kiln to take on its
 * own, which whoever called does once this lets go of the instance.
 */
const recordImageAnswersEffect = Effect.fnUntraced(function* (
  kind: InstanceUpdateKind,
  relay: PersistedRelay,
  instanceId: string,
  asked: { answers: ReadonlyArray<InstanceImageAnswer>; unchecked: boolean },
  actorUserId: string | null
) {
  const adapter = updatedKind(kind)
  // One checked on its own that no longer checks, as an App now pinned to a
  // digest or deployed from elsewhere, has no update on offer: read again
  // here, holding it, since checks may have been turned on since and a
  // newer check announced an update.
  if (asked.unchecked && !(yield* checksForUpdates(kind, relay.id, instanceId))) {
    yield* resolveInstanceUpdateNotificationsEffect(
      kind,
      relay.id,
      instanceId,
      { unchecked: true }
    )
  }
  let changed = false
  const due: Array<DueUpdate> = []
  for (const { askedAt, result, subject } of asked.answers) {
    if (subject.id !== instanceId) continue
    // Gone since it was asked about.
    const named = yield* adapter.namedImage(relay.id, instanceId)
    if (named === undefined) continue
    // Its Brick, whatever the image check found. A newer revision due on
    // its own replaces the container, and may run another image: the image
    // is judged again once that has deployed, not now.
    let installing = false
    if (result.brick) {
      const brick = yield* recordBrickAnswerEffect(
        kind,
        relay,
        subject,
        result.brick,
        askedAt,
        actorUserId
      )
      changed ||= brick.changed
      if (brick.due !== null) {
        installing = true
        due.push({ of: "brick", revision: brick.due })
      }
    }
    // Asked about an image it no longer names.
    if (named !== subject.image) continue
    const recorded = yield* recordInstanceImageCheckEffect(
      kind,
      instanceId,
      // What Hearth knows it names, or what the Relay found it running.
      subject.image ?? (result.status === "checked" ? result.image : null),
      result,
      askedAt
    )
    changed ||= recorded.changed
    if (recorded.newFailure) {
      yield* Effect.logWarning(
        "Could not check an instance for image updates"
      ).pipe(
        Effect.annotateLogs({
          "error.message": recorded.update.checkError,
          "instance.id": instanceId,
          "instance.kind": kind,
          "relay.id": relay.id,
        })
      )
    }
    if (recorded.newlySeen) {
      yield* announce(relay, subject.name, recorded.update, actorUserId)
    }
    // An update that's gone, skipped, or replaced by a newer image no longer
    // needs anyone's attention.
    yield* resolveInstanceUpdateNotificationsEffect(kind, relay.id, instanceId)
    const at = autoUpdateAt(recorded.update)
    const digest = recorded.update.latestDigest
    if (
      !installing &&
      digest !== null &&
      at !== null &&
      at <= (yield* Clock.currentTimeMillis)
    ) {
      due.push({ digest, of: "image" })
    }
  }
  return { changed, due }
})

// Records which revision of its Brick an instance runs against the
// catalog's, and tells whoever can deploy it about a newer one they
// haven't heard of. Reports whether it changed what Kiln knows, and the
// newer revision that has waited long enough to install on its own. An
// answer older than one already recorded, or than a deployment, which may
// have changed its Brick, says nothing of what it runs now.
const recordBrickAnswerEffect = Effect.fnUntraced(function* (
  kind: InstanceUpdateKind,
  relay: PersistedRelay,
  subject: UpdateSubject,
  installed: { revision: number; source: string },
  askedAt: number,
  actorUserId: string | null
) {
  const startedAt = yield* updatedKind(kind).latestDeploymentStartedAt(
    subject.id
  )
  if (startedAt !== null && Date.parse(startedAt) >= askedAt) {
    return { changed: false, due: null }
  }
  const catalog = yield* promiseEffect(() =>
    newestBrickRevision(installed.source)
  )
  const recorded = yield* recordInstanceBrickCheckEffect(
    kind,
    subject.id,
    installed,
    catalog?.revision ?? null,
    askedAt
  )
  if (recorded.stale) return { changed: false, due: null }
  const update = (yield* loadInstanceUpdatesEffect([subject.id])).get(
    subject.id
  )
  const offered = update ? offeredBrickRevision(update) : null
  const prefix = `instance.brick-update:${subject.id}:`
  if (recorded.newlySeen && offered !== null && catalog) {
    const { resourceType } = updatedKind(kind)
    const recipients = yield* notificationAudienceEffect(
      { relayId: relay.id, resourceId: subject.id, resourceType },
      // Whoever may take it: installing a newer recipe is a deploy.
      "instance.deploy",
      "instance.brick-update"
    )
    const delivered = yield* notifyUsersEffect(
      recipients,
      `${prefix}${offered}`,
      {
        brickName: catalog.name,
        kind: "instance.brick-update",
        resource: {
          id: subject.id,
          name: subject.name,
          relayId: relay.id,
          type: resourceType,
        },
        revision: offered,
      },
      { actorUserId }
    )
    if (delivered > 0) publishNotificationChange(recipients)
  }
  // A revision that's installed, skipped, or replaced by a newer one no
  // longer needs anyone's attention.
  const open = yield* openSourceKeysEffect("instance.brick-update", prefix)
  publishNotificationChange(
    yield* resolveNotificationsEffect(
      "instance.brick-update",
      open.filter((key) => key !== `${prefix}${offered}`)
    )
  )
  const at = update ? autoBrickUpdateAt(update) : null
  return {
    changed: recorded.changed,
    due:
      offered !== null && at !== null && at <= (yield* Clock.currentTimeMillis)
        ? offered
        : null,
  }
})

// Whether an instance checks for image updates now: its image could move,
// and it hasn't turned checks off.
const checksForUpdates = Effect.fnUntraced(function* (
  kind: InstanceUpdateKind,
  relayId: string,
  instanceId: string
) {
  if ((yield* updatedKind(kind).namedImage(relayId, instanceId)) === undefined) {
    return false
  }
  const update = (yield* loadInstanceUpdatesEffect([instanceId])).get(instanceId)
  return (update?.mode ?? defaultInstanceUpdatePolicy.mode) !== "off"
})

// How many of Kiln's own updates deploy at once on each Relay.
const ownUpdatesAtOnce = 2
const ownUpdateTurns = new Map<string, Semaphore.Semaphore>()

// Starts an update Kiln found due, apart from the check that found it: a
// deploy takes minutes, and the instances checked next shouldn't wait for
// it. A few run at once on each Relay. Nothing is kept of one that hasn't
// started: its kind judges it again as it starts (`UpdatedKind.autoUpdate`),
// and the next check that finds it due starts it again.
function startOwnUpdate(
  kind: InstanceUpdateKind,
  relay: PersistedRelay,
  instanceId: string,
  due: DueUpdate
): void {
  let turns = ownUpdateTurns.get(relay.id)
  if (!turns) {
    turns = Semaphore.makeUnsafe(ownUpdatesAtOnce)
    ownUpdateTurns.set(relay.id, turns)
  }
  const taking = turns.withPermits(1)(
    updatedKind(kind).autoUpdate(relay, instanceId, due)
  )
  outsideOperation(() =>
    forkAppWorker(
      taking.pipe(
        // Its deployment's record and log say how one that ran went.
        Effect.catchCause((cause) =>
          logException(Cause.squash(cause), {
            operation: "Instances.updates.auto",
            attributes: {
              "instance.id": instanceId,
              "instance.kind": kind,
              "relay.id": relay.id,
            },
          })
        )
      )
    )
  )
}

// Kiln's own checks: ask with no lane held, record each instance's answer
// holding the instance shared, then start what has waited long enough for
// Kiln to take on its own, which deploys apart from the checks.
const checkImagesEffect = (
  kind: InstanceUpdateKind,
  relay: PersistedRelay,
  onlyId?: string,
  actorUserId: string | null = null
) => {
  const adapter = updatedKind(kind)
  let changed = false
  const record = (
    instanceId: string,
    asked: { answers: ReadonlyArray<InstanceImageAnswer>; unchecked: boolean }
  ) =>
    inLanes(
      "instance.image.check.record",
      "Checking this instance's image",
      [shared(resourceKey(adapter.resourceType, relay.id, instanceId))],
      recordImageAnswersEffect(kind, relay, instanceId, asked, actorUserId)
    ).pipe(
      Effect.tap((recorded) =>
        Effect.sync(() => {
          changed ||= recorded.changed
        })
      ),
      Effect.tap(({ due }) =>
        Effect.sync(() => {
          for (const update of due) {
            startOwnUpdate(kind, relay, instanceId, update)
          }
        })
      )
    )
  return Effect.gen(function* () {
    // Each batch is recorded before the next is asked for.
    const unchecked = yield* askImagesEffect(kind, relay, onlyId, (answers) =>
      Effect.forEach(
        answers,
        (answer) =>
          record(answer.subject.id, { answers: [answer], unchecked: false }),
        { discard: true }
      )
    )
    if (unchecked && onlyId) {
      yield* record(onlyId, { answers: [], unchecked: true })
    }
  }).pipe(
    // What was recorded shows, even when a later batch failed.
    Effect.ensuring(
      Effect.sync(() => {
        if (changed) adapter.published(relay.id)
      })
    )
  )
}

export function startInstanceUpdateChecks(): void {
  const sweep = Effect.gen(function* () {
    for (const relay of yield* listPersistedRelaysEffect()) {
      if (!relay.enabled) continue
      for (const { kind } of updatedKinds) {
        yield* checkImagesEffect(kind, relay).pipe(
          Effect.catchCause((cause) =>
            logException(Cause.squash(cause), {
              operation: "Instances.updates.check",
              attributes: { "instance.kind": kind, "relay.id": relay.id },
            })
          )
        )
      }
    }
  }).pipe(
    Effect.catchCause((cause) =>
      logException(Cause.squash(cause), {
        operation: "Instances.updates.sweep",
      })
    )
  )
  // The first sweep waits a little, so Relays have connected.
  globalThis.kilnInstanceUpdateChecker ??= forkAppWorker(
    Effect.sleep("1 minute").pipe(
      Effect.andThen(sweep.pipe(Effect.repeat(Schedule.spaced(sweepInterval)))),
      Effect.asVoid
    )
  )
}

export function stopInstanceUpdateChecks(): Promise<void> {
  const checker = globalThis.kilnInstanceUpdateChecker
  globalThis.kilnInstanceUpdateChecker = undefined
  return checker
    ? Effect.runPromise(Fiber.interrupt(checker))
    : Promise.resolve()
}

if (import.meta.hot) import.meta.hot.dispose(() => stopInstanceUpdateChecks())

/**
 * Asks about one instance now, as when someone asks, with no lane held;
 * record the answer holding the instance (`recordCheckedImageEffect`).
 */
export const askInstanceImageEffect = Effect.fn("Instances.updates.ask")(
  function* (kind: InstanceUpdateKind, relay: PersistedRelay, id: string) {
    if (!relay.enabled) {
      return yield* Effect.fail(new Error("This Relay is turned off"))
    }
    const answers: Array<InstanceImageAnswer> = []
    const unchecked = yield* askImagesEffect(kind, relay, id, (batch) =>
      Effect.sync(() => {
        answers.push(...batch)
      })
    )
    return { answers, unchecked }
  }
)

/**
 * Records what asking about one instance found, run holding it, and answers
 * what Kiln knows of its updates after.
 */
export const recordCheckedImageEffect = Effect.fn("Instances.updates.record")(
  function* (
    kind: InstanceUpdateKind,
    relay: PersistedRelay,
    instanceId: string,
    asked: { answers: ReadonlyArray<InstanceImageAnswer>; unchecked: boolean },
    actorUserId: string | null
  ) {
    // Someone's own check, run holding the instance: it records, and
    // leaves what is due for Kiln's next check, which holds nothing.
    const recorded = yield* recordImageAnswersEffect(
      kind,
      relay,
      instanceId,
      asked,
      actorUserId
    )
    if (recorded.changed) updatedKind(kind).published(relay.id)
    const updates = yield* loadInstanceUpdatesEffect([instanceId])
    return updates.get(instanceId) ?? null
  }
)

/**
 * Checks again after an instance deploys, so it shows what it runs, or
 * after someone (`actorUserId`) changed how it updates.
 */
export function recheckInstanceImage(
  kind: InstanceUpdateKind,
  relayId: string,
  instanceId: string,
  actorUserId: string | null
): void {
  // Asked for by whatever changed it, which doesn't wait for it.
  outsideOperation(() =>
    forkAppWorker(
      Effect.gen(function* () {
        const relays = yield* listPersistedRelaysEffect()
        const relay = relays.find((item) => item.id === relayId)
        if (relay?.enabled) {
          yield* checkImagesEffect(kind, relay, instanceId, actorUserId)
        }
        // A deployment makes what was known of it stale, and whoever
        // looked meanwhile saw nothing on offer. Checked again, what it
        // has may be what it had: said anyway, so they look again.
        updatedKind(kind).published(relayId)
      }).pipe(
        Effect.catchCause((cause) =>
          logException(Cause.squash(cause), {
            operation: "Instances.updates.recheck",
            attributes: {
              "instance.id": instanceId,
              "instance.kind": kind,
              "relay.id": relayId,
            },
          })
        )
      )
    )
  )
}
