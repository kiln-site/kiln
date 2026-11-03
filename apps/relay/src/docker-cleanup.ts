/**
 * Removes what Kiln leaves on Docker once it's done with it. Work that
 * replaces a container removes the old one itself; a removal Docker refuses
 * is kept in Relay's state and tried again by each pass here, in its owner's
 * lane, so a failure never leaves a container behind for good. A pass also
 * removes what a finished Hearth or Relay update left: its stopped helper
 * and the old container it set aside, which the helper, running in its own
 * process, can't hand to Relay's state.
 *
 * Images: each App keeps the images of its newest successful deployments,
 * and a build stays a day whatever became of its deployment; Hearth and the
 * Relay keep the image they ran before their latest update, for a
 * downgrade. Any other image goes once none of Kiln's containers has used
 * it for a day; an image Kiln's containers never ran is never Kiln's to
 * remove. Passes run hourly, and sooner while the disk is nearly full. See
 * docs/relay-runtime.md.
 */
import { statfs } from "node:fs/promises"

import { Clock, Effect, Metric } from "effect"

import type { RelayConfig } from "./config.js"
import {
  imageOwnBytes,
  keptDeployments,
  removableImages,
  type ImageRemoval,
  type ImageRemovalKind,
  type RetentionRules,
} from "./docker-image-retention.js"
import {
  containerName,
  isDockerNotFound,
  type DockerEngine,
  type DockerImageSummary,
} from "./docker-engine.js"
import type {
  RelayDockerCleanupOwner,
  RelayDockerCleanupRecord,
  RelayStateStore,
} from "./effect/state.js"
import {
  exclusive,
  laneKeys,
  LaneRejectedError,
  shared,
  type LaneLock,
  type OperationLanes,
} from "./operation-lanes.js"
import {
  appLifecycleLocks,
  databaseLifecycleLocks,
  instanceLifecycleLocks,
} from "./operation-plans.js"
import {
  operation,
  runOperation,
  type RelayCaller,
  type RelayOperation,
} from "./operations/operation.js"
import {
  kilnContainerOwner,
  type KilnContainerOwner,
} from "./kiln-containers.js"
import type { ImageFacts } from "./docker-image-retention.js"
import type { UpdateCleanupState } from "./system-updates.js"
import { KILN_INSTALLATION_LABEL, kilnComponent } from "./update-container.js"

const UPDATE_HELPER_LABEL = "io.kiln.update-helper"
// What the Relay names an update's helper (system-updates.ts).
const UPDATE_HELPER_PREFIX = "kiln-updater-"
// Docker states of a container that won't run again by itself.
const EXITED = new Set(["dead", "exited"])
// How long an update helper, or the container it set aside, has been
// stopped before it counts as left over without a record saying so. An
// update finishes or rolls back within minutes.
const LEGACY_LEFTOVER_AGE_MS = 24 * 60 * 60_000
// What the update helper renames the container it replaces to, until the
// replacement is healthy (updater.ts).
const UPDATE_BACKUP_NAME = /^(.+)-kiln-backup-\d+$/u
// How long an image nothing uses stays, so a game server deleted and made
// again, or a service turned off and on, doesn't download it again.
const UNUSED_IMAGE_GRACE_MS = 24 * 60 * 60_000
// Image removals a pass makes at most, so one never holds cleanup long; a
// person's cleanup goes further.
const IMAGES_PER_PASS = 50
const IMAGES_PER_CLEANUP = 500
const PASS_INTERVAL_MS = 60 * 60_000
// While the disk is this full, passes run this often instead.
const DISK_PRESSURE = 0.9
const PRESSURE_PASS_INTERVAL_MS = 10 * 60_000

const removed = Metric.counter("relay.docker.cleanup.removed", {
  description: "Containers Relay removed after the work that left them",
  attributes: { unit: "{container}" },
  incremental: true,
})

const refused = Metric.counter("relay.docker.cleanup.refused", {
  description: "Container removals Docker refused, to be tried again",
  attributes: { unit: "{container}" },
  incremental: true,
})

const imagesRemoved = Metric.counter("relay.docker.cleanup.images.removed", {
  description: "Images Relay removed once nothing kept them",
  attributes: { unit: "{image}" },
  incremental: true,
})

const imageBytesRemoved = Metric.counter(
  "relay.docker.cleanup.images.removed.bytes",
  {
    description: "Sizes of the images Relay removed, shared layers included",
    attributes: { unit: "By" },
    incremental: true,
  }
)

type RemovalKind = "leftover" | "update-backup" | "update-helper"

// Whether a removal took, and the failure if it's one this cleanup reports.
interface RemovalOutcome {
  readonly error: string | null
  readonly removed: boolean
}

/** What a cleanup removed. */
export interface DockerCleanupResult {
  readonly buildCacheBytes: number
  readonly containers: number
  /** Why it stopped short, when it did. */
  readonly error: string | null
  /** What the removed images held of their own, shared layers left out. */
  readonly imageBytes: number
  readonly images: number
}

/** What a person asks a cleanup to remove beyond what passes do. */
export interface DockerCleanupRequest {
  /** BuildKit's unused cache, the host's own builds' too. */
  readonly buildCache: boolean
  /** Unused images no Kiln container ran, such as a person's own. */
  readonly unknownImages: boolean
}

/** What Docker holds on the host, and what a cleanup could remove of it. */
export interface DockerStorage {
  readonly buildCache: {
    readonly bytes: number
    readonly reclaimableBytes: number
  }
  readonly images: { readonly bytes: number; readonly count: number }
  /** Containers Docker refused to remove, which passes try again. */
  readonly leftoverContainers: number
  /** What a cleanup now would remove of Kiln's own. */
  readonly reclaimable: { readonly bytes: number; readonly images: number }
  /** Unused images no Kiln container ran, removed only when asked. */
  readonly unknown: { readonly bytes: number; readonly images: number }
  /** A cleanup someone asked for that's still running. */
  readonly cleaning: { readonly startedAt: number } | null
  readonly lastCleanup:
    | (DockerCleanupResult & {
        readonly finishedAt: number
        readonly requested: boolean
      })
    | null
}

interface CollectInput {
  readonly limit: number
  readonly request: DockerCleanupRequest
  readonly rules: Omit<RetentionRules, "kilnImages" | "unknownImages">
  /** Only an App's builds, after its deployment. */
  readonly appId: string | null
}

const NOTHING: DockerCleanupResult = {
  buildCacheBytes: 0,
  containers: 0,
  error: null,
  imageBytes: 0,
  images: 0,
}

type CleanupConfig = Pick<
  RelayConfig,
  | "dataDirectory"
  | "installationId"
  | "mode"
  | "resourceNamespace"
  | "selfContainer"
  | "serverIdLabel"
>

export interface DockerCleanupOptions {
  readonly config: CleanupConfig
  readonly engine: DockerEngine
  readonly lanes: OperationLanes
  readonly state: RelayStateStore["Service"]
  /** What Hearth's and the Relay's updates are doing and named. */
  readonly updates: () => Effect.Effect<UpdateCleanupState>
}

export class DockerCleanup {
  readonly #config: CleanupConfig
  readonly #engine: DockerEngine
  readonly #lanes: OperationLanes
  readonly #state: RelayStateStore["Service"]
  readonly #updates: DockerCleanupOptions["updates"]
  #lastCleanup: DockerStorage["lastCleanup"] = null
  // A cleanup someone asked for, while it runs in the background.
  #requested: { readonly startedAt: number } | null = null
  // The figures storage() last counted, shown again while a cleanup runs
  // rather than have Docker count every image's layers mid-removal.
  #figures: Omit<DockerStorage, "cleaning" | "lastCleanup"> | null = null

  constructor(options: DockerCleanupOptions) {
    this.#updates = options.updates
    this.#config = options.config
    this.#engine = options.engine
    this.#lanes = options.lanes
    this.#state = options.state
  }

  /**
   * Removes a container Relay is done with, by its ID, never its name,
   * which a later container can take. One Docker refuses is kept and tried
   * again by the next pass; the caller's work carries on either way.
   */
  removeContainer(
    containerId: string,
    input: {
      readonly owner: RelayDockerCleanupOwner | null
      readonly reason: string
      /** Its anonymous volumes too, as `docker rm --volumes`. */
      readonly volumes?: boolean
    }
  ): Effect.Effect<void> {
    const state = this.#state
    const volumes = input.volumes ?? false
    return this.#remove(containerId, volumes).pipe(
      Effect.tap(() => count(removed, "leftover")),
      Effect.catch((cause) =>
        Effect.gen(function* () {
          yield* count(refused, "leftover")
          const now = yield* Clock.currentTimeMillis
          yield* state
            .recordDockerCleanup(
              {
                containerId,
                error: cause.message,
                owner: input.owner,
                reason: input.reason,
                volumes,
              },
              now
            )
            .pipe(Effect.ignore)
          yield* Effect.logWarning(
            "Docker didn't remove a container; Relay will try again",
            { containerId, reason: input.reason, error: cause.message }
          )
        })
      )
    )
  }

  /**
   * Records the images a successful deployment runs: they're kept while it's
   * among the App's newest few, and in use from now for the day after.
   */
  recordDeployment(input: {
    readonly appId: string
    readonly deploymentId: string
    readonly imageIds: ReadonlyArray<string>
  }): Effect.Effect<void> {
    const state = this.#state
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((finishedAt) =>
        Effect.all([
          state.recordAppDeploymentImages({ ...input, finishedAt }),
          state.noteDockerImagesUsed(
            input.imageIds.map((imageId) => ({
              imageId,
              owner: `app:${input.appId}`,
            })),
            finishedAt
          ),
        ])
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Relay couldn't record a deployment's images", cause)
      ),
      Effect.asVoid
    )
  }

  /**
   * Notes a build as it finishes, whatever becomes of its deployment: it's
   * the App's, and kept a day from now.
   */
  noteBuild(appId: string, imageId: string): Effect.Effect<void> {
    const state = this.#state
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((now) =>
        state.noteDockerImagesUsed([{ imageId, owner: `app:${appId}` }], now)
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Relay couldn't record an App's build", cause)
      )
    )
  }

  /**
   * Removes the App's builds that none of its newest successful
   * deployments runs, once they're a day old. Waits behind other cleanup,
   * but not for the App's next deployment.
   */
  pruneAppImages(appId: string): Effect.Effect<void> {
    return runOperation(
      this.#lanes,
      this.#collect,
      {
        appId,
        limit: IMAGES_PER_CLEANUP,
        request: { buildCache: false, unknownImages: false },
        rules: { unusedGraceMs: UNUSED_IMAGE_GRACE_MS },
      },
      { kind: "worker" }
    ).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Relay couldn't remove an App's old images", cause)
      ),
      Effect.asVoid
    )
  }

  /**
   * A pass: what finished updates left, each kept container again in its
   * owner's lane, then images. Work in the way leaves its part for the next
   * pass.
   */
  pass(caller: RelayCaller): Effect.Effect<void> {
    return this.#cleanup(
      {
        appId: null,
        limit: IMAGES_PER_PASS,
        request: { buildCache: false, unknownImages: false },
        rules: { unusedGraceMs: UNUSED_IMAGE_GRACE_MS },
      },
      caller,
      true
    ).pipe(Effect.asVoid)
  }

  /**
   * A cleanup a person asked for: what a pass removes, without waiting a
   * day for images no Kiln container uses, and what they chose besides. It
   * waits for other cleanup rather than turning away.
   */
  cleanNow(request: DockerCleanupRequest): Effect.Effect<DockerCleanupResult> {
    return this.#cleanup(
      {
        appId: null,
        limit: IMAGES_PER_CLEANUP,
        request,
        rules: { unusedGraceMs: 0 },
      },
      { kind: "worker" },
      false
    )
  }

  /**
   * Starts a cleanup someone asked for and answers at once: it runs in the
   * background, and `storage()` shows it until it's done. One already
   * running is left to finish rather than started again.
   */
  startCleanup(request: DockerCleanupRequest): Effect.Effect<{
    readonly alreadyRunning: boolean
    readonly startedAt: number
  }> {
    return Effect.gen({ self: this }, function* () {
      if (this.#requested) {
        return { alreadyRunning: true, startedAt: this.#requested.startedAt }
      }
      const startedAt = yield* Clock.currentTimeMillis
      const requested = { startedAt }
      this.#requested = requested
      yield* Effect.forkDetach(
        this.cleanNow(request).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (this.#requested === requested) this.#requested = null
            })
          )
        )
      )
      return { alreadyRunning: false, startedAt }
    })
  }

  /**
   * What Docker holds and what a cleanup now could remove. Asks Docker to
   * count every image's layers, so only when someone wants the figures,
   * and not while a cleanup runs: the last figures stand until it's done.
   */
  storage(): Effect.Effect<DockerStorage, unknown> {
    const requested = this.#requested
    if (requested && this.#figures) {
      return Effect.succeed({
        ...this.#figures,
        cleaning: { startedAt: requested.startedAt },
        lastCleanup: this.#lastCleanup,
      })
    }
    return Effect.gen({ self: this }, function* () {
      const [usage, containers, leftovers] = yield* Effect.all(
        [
          this.#engine.imageDiskUsage({ timeout: 60_000 }),
          this.#engine.listContainers({ all: true }),
          this.#state.listDockerCleanups(),
        ],
        { concurrency: 3 }
      )
      const images = usage.Images ?? []
      const removals = yield* this.#removals(images, containers, {
        unknownImages: true,
        unusedGraceMs: 0,
      })
      const total = (kinds: (kind: ImageRemovalKind) => boolean) => {
        const chosen = removals.filter((removal) => kinds(removal.kind))
        return {
          bytes: chosen.reduce(
            (sum, removal) => sum + imageOwnBytes(removal.image),
            0
          ),
          images: chosen.length,
        }
      }
      const cache = usage.BuildCache ?? []
      const figures = {
        buildCache: {
          bytes: cache.reduce((sum, record) => sum + (record.Size ?? 0), 0),
          reclaimableBytes: cache.reduce(
            (sum, record) => sum + (record.InUse ? 0 : (record.Size ?? 0)),
            0
          ),
        },
        images: {
          bytes:
            usage.LayersSize ??
            images.reduce((sum, image) => sum + imageOwnBytes(image), 0),
          count: images.length,
        },
        leftoverContainers: leftovers.length,
        reclaimable: total((kind) => kind !== "unknown"),
        unknown: total((kind) => kind === "unknown"),
      }
      this.#figures = figures
      return {
        ...figures,
        cleaning: this.#requested && { startedAt: this.#requested.startedAt },
        lastCleanup: this.#lastCleanup,
      }
    })
  }

  /**
   * Passes for as long as the Relay runs: a minute after it starts, then
   * hourly, and every ten minutes while the disk holding the Relay's data,
   * usually Docker's too, is nearly full. Each pass is its own operations.
   */
  run(): Effect.Effect<never> {
    let lastPass = Number.NEGATIVE_INFINITY
    return Effect.sleep("1 minute").pipe(
      Effect.andThen(
        Effect.gen({ self: this }, function* () {
          const now = yield* Clock.currentTimeMillis
          const due =
            now - lastPass >= PASS_INTERVAL_MS ||
            (now - lastPass >= PRESSURE_PASS_INTERVAL_MS &&
              (yield* this.#underPressure()))
          if (due) {
            lastPass = now
            yield* this.pass({ kind: "timer" })
          } else {
            // Between passes too, so a game server or database made and
            // deleted within the hour still counts as Kiln's.
            yield* this.#noteUsed().pipe(Effect.ignore)
          }
          yield* Effect.sleep("5 minutes")
        }).pipe(Effect.forever)
      )
    )
  }

  #cleanup(
    input: CollectInput,
    caller: RelayCaller,
    onlyIfFree: boolean
  ): Effect.Effect<DockerCleanupResult> {
    const lanes = this.#lanes
    const state = this.#state
    const admit = <I, A>(
      definition: RelayOperation<I, A, never, never>,
      operationInput: I,
      busy: A
    ) =>
      runOperation(
        lanes,
        { ...definition, onlyIfFree: onlyIfFree || definition.onlyIfFree },
        operationInput,
        caller
      ).pipe(
        Effect.catchIf(
          (cause) => cause instanceof LaneRejectedError,
          () => Effect.succeed(busy)
        )
      )
    return Effect.gen({ self: this }, function* () {
      const swept = yield* admit(this.#sweepUpdates, undefined, {
        error: null,
        removed: 0,
      })
      // A leftover Docker still refuses stays recorded, and counted, for
      // the next pass: not a failure of this cleanup.
      let retried = 0
      for (const leftover of yield* state.listDockerCleanups()) {
        if (yield* admit(this.#retryRemoval, leftover, false)) retried += 1
      }
      const collected = yield* admit(this.#collect, input, NOTHING)
      const result = {
        ...collected,
        containers: swept.removed + retried,
        error: swept.error ?? collected.error,
      }
      const finishedAt = yield* Clock.currentTimeMillis
      this.#lastCleanup = { ...result, finishedAt, requested: !onlyIfFree }
      return result
    }).pipe(
      // Kept as the latest cleanup too, so someone who asked for it hears
      // how it ended.
      Effect.catch((cause) =>
        Effect.gen({ self: this }, function* () {
          yield* Effect.logWarning("Docker cleanup didn't finish", cause)
          const result = { ...NOTHING, error: errorMessage(cause) }
          const finishedAt = yield* Clock.currentTimeMillis
          this.#lastCleanup = { ...result, finishedAt, requested: !onlyIfFree }
          return result
        })
      )
    )
  }

  // Notes the images Kiln's containers use now.
  #noteUsed(listed?: ImageFacts["containers"]): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const containers =
        listed ?? (yield* this.#engine.listContainers({ all: true }))
      const now = yield* Clock.currentTimeMillis
      yield* this.#state.noteDockerImagesUsed(
        containers.flatMap((container) => {
          const owner = kilnContainerOwner(this.#config, container)
          return owner && container.ImageID
            ? [{ imageId: container.ImageID, owner: ownerKey(owner) }]
            : []
        }),
        now
      )
    })
  }

  #underPressure(): Effect.Effect<boolean> {
    return Effect.tryPromise(() => statfs(this.#config.dataDirectory)).pipe(
      Effect.map(
        (disk) =>
          disk.blocks > 0 && 1 - disk.bavail / disk.blocks >= DISK_PRESSURE
      ),
      Effect.orElseSucceed(() => false)
    )
  }

  // What the rules would remove now. Hearth's and the Relay's old images
  // only while no update runs, as a rollback needs the old one.
  #removals(
    images: ReadonlyArray<DockerImageSummary>,
    containers: ImageFacts["containers"],
    rules: Omit<RetentionRules, "kilnImages">
  ): Effect.Effect<Array<ImageRemoval>, unknown> {
    return Effect.gen({ self: this }, function* () {
      const [records, deployments, updates, now] = yield* Effect.all([
        this.#state.listDockerImages(),
        this.#state.listAppDeploymentImages(),
        this.#updates(),
        Clock.currentTimeMillis,
      ])
      return removableImages(
        {
          containers,
          deployments,
          images,
          now,
          ownsApp: (container) => {
            const owner = kilnContainerOwner(this.#config, container)
            return owner?.resource.type === "app" ? owner.resource.id : null
          },
          kilnUpdates: updates,
          records,
        },
        { ...rules, kilnImages: !updates.updating }
      )
    })
  }

  // Notes which images Kiln's containers use now, then removes what the
  // rules allow, and BuildKit's unused cache when asked. Beside each App's
  // deployments, which hold it shared: a deployment that finds an image it
  // pulled gone pulls it again, and each build is new. After a deployment,
  // only that App's builds, and its deletion, which removes them itself,
  // waits.
  readonly #collect = operation<CollectInput>()({
    name: "relay.docker.cleanup.images",
    locks: ({ input }) => [
      exclusive(laneKeys.dockerCleanup),
      ...(input.appId ? [shared(laneKeys.app(input.appId))] : []),
    ],
    run: ({ input }) =>
      Effect.gen({ self: this }, function* () {
        const [containers, images] = yield* Effect.all(
          [
            this.#engine.listContainers({ all: true }),
            this.#engine.listImages(),
          ],
          { concurrency: 2 }
        )
        yield* this.#noteUsed(containers)
        const present = new Set(images.map((image) => image.Id))
        for (const record of yield* this.#state.listDockerImages()) {
          if (!present.has(record.imageId)) {
            yield* this.#state.forgetDockerImage(record.imageId)
          }
        }
        const removals = (yield* this.#removals(images, containers, {
          ...input.rules,
          unknownImages: input.request.unknownImages,
        }))
          .filter(
            (removal) =>
              input.appId === null ||
              (removal.kind === "app" && removal.appId === input.appId)
          )
          .slice(0, input.limit)
        let removedImages = 0
        let imageBytes = 0
        let error: string | null = null
        for (const removal of removals) {
          const outcome = yield* this.#removeImage(removal.image, removal.kind)
          error ??= outcome.error
          if (outcome.removed) {
            removedImages += 1
            imageBytes += imageOwnBytes(removal.image)
            yield* this.#state.forgetDockerImage(removal.image.Id)
          }
        }
        // Deployments no longer among their App's newest have nothing more
        // to keep.
        const deployments = yield* this.#state.listAppDeploymentImages()
        const kept = keptDeployments(deployments)
        const dropped = new Map<string, Set<string>>()
        for (const record of deployments) {
          if (kept.has(`${record.appId}/${record.deploymentId}`)) continue
          const app = dropped.get(record.appId) ?? new Set<string>()
          app.add(record.deploymentId)
          dropped.set(record.appId, app)
        }
        for (const [appId, deploymentIds] of dropped) {
          yield* this.#state.forgetAppDeploymentImages(appId, [
            ...deploymentIds,
          ])
        }
        const buildCacheBytes = input.request.buildCache
          ? ((yield* this.#engine.pruneBuildCache()).SpaceReclaimed ?? 0)
          : 0
        return {
          ...NOTHING,
          buildCacheBytes,
          error,
          imageBytes,
          images: removedImages,
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Relay couldn't remove images", cause).pipe(
            Effect.as({ ...NOTHING, error: errorMessage(cause) })
          )
        )
      ),
  })

  readonly #retryRemoval = operation<RelayDockerCleanupRecord>()({
    name: "relay.docker.cleanup.leftover",
    locks: ({ input }) => ownerLocks(input.owner),
    onlyIfFree: true,
    run: ({ input }) => {
      const state = this.#state
      return this.#remove(input.containerId, input.volumes).pipe(
        Effect.andThen(state.forgetDockerCleanup(input.containerId)),
        Effect.andThen(count(removed, "leftover")),
        Effect.as(true),
        Effect.catch((cause) =>
          Effect.gen(function* () {
            yield* count(refused, "leftover")
            const now = yield* Clock.currentTimeMillis
            yield* state.recordDockerCleanup(
              {
                containerId: input.containerId,
                error: cause.message,
                owner: input.owner,
                reason: input.reason,
                volumes: input.volumes,
              },
              now
            )
            // Once a day for one that keeps failing, at hourly passes.
            if (input.failures % 24 === 0) {
              yield* Effect.logWarning(
                "Docker still won't remove a leftover container",
                {
                  containerId: input.containerId,
                  error: cause.message,
                  failures: input.failures + 1,
                  reason: input.reason,
                }
              )
            }
            return false
          })
        ),
        Effect.orElseSucceed(() => false)
      )
    },
  })

  // The helper of a finished update, and the container it set aside once
  // the replacement under its name runs. Nothing while any update starts or
  // runs, by this Relay's records or a helper anyone's update made that
  // hasn't exited: a helper may still roll back to the container it set
  // aside. Helpers and set-aside containers of updates this Relay recorded
  // as finished go, and, from before updates were recorded, ones Kiln's
  // updater named that have been stopped for a day.
  readonly #sweepUpdates = operation<void>()({
    name: "relay.docker.cleanup.updates",
    locks: () => [exclusive(laneKeys.dockerCleanup)],
    run: () =>
      Effect.gen({ self: this }, function* () {
        let removed = 0
        let error: string | null = null
        const remove = (containerId: string, kind: RemovalKind) =>
          this.#removeSwept(containerId, kind).pipe(
            Effect.tap((outcome) =>
              Effect.sync(() => {
                if (outcome.removed) removed += 1
                error ??= outcome.error
              })
            )
          )
        const updates = yield* this.#updates()
        if (updates.updating) return { error, removed }
        const containers = yield* this.#engine.listContainers({ all: true })
        const helpers = containers.filter(
          (container) => container.Labels?.[UPDATE_HELPER_LABEL] === "true"
        )
        if (helpers.some((helper) => !EXITED.has(helper.State))) {
          return { error, removed }
        }
        const byName = new Map(
          containers.map((container) => [containerName(container), container])
        )
        const now = yield* Clock.currentTimeMillis
        for (const helper of helpers) {
          const name = containerName(helper)
          if (
            !updates.finishedHelpers.has(name) &&
            !(
              name.startsWith(UPDATE_HELPER_PREFIX) &&
              (yield* this.#stoppedLongAgo(helper.Id, now))
            )
          ) {
            continue
          }
          yield* remove(helper.Id, "update-helper")
        }
        for (const container of containers) {
          if (container.State === "running") continue
          const original = UPDATE_BACKUP_NAME.exec(
            containerName(container)
          )?.[1]
          if (!original || byName.get(original)?.State !== "running") continue
          const labels = container.Labels ?? {}
          if (!kilnComponent(labels["io.kiln.component"])) continue
          // One an update this Relay recorded set aside, or, from before
          // updates were recorded, one stopped for a day: no update holds
          // its rollback copy that long.
          if (
            !updates.targets.has(original) &&
            !(yield* this.#stoppedLongAgo(container.Id, now))
          ) {
            continue
          }
          const installation = labels[KILN_INSTALLATION_LABEL]
          if (installation && installation !== this.#config.installationId) {
            continue
          }
          yield* remove(container.Id, "update-backup")
        }
        return { error, removed }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(
            "Relay couldn't look for update leftovers",
            cause
          ).pipe(Effect.as({ error: errorMessage(cause), removed: 0 }))
        )
      ),
  })

  // Whether a container stopped over a day ago, by when Docker says it
  // finished; one that never ran, or can't be read, didn't.
  #stoppedLongAgo(containerId: string, now: number): Effect.Effect<boolean> {
    return this.#engine
      .inspectContainer<{ readonly State: { readonly FinishedAt?: string } }>(
        containerId
      )
      .pipe(
        Effect.map((container) => {
          const finished = Date.parse(container.State.FinishedAt ?? "")
          return (
            Number.isFinite(finished) &&
            finished > 0 &&
            now - finished >= LEGACY_LEFTOVER_AGE_MS
          )
        }),
        Effect.orElseSucceed(() => false)
      )
  }

  // Unforced, so Docker keeps one a container started using meanwhile:
  // that refusal (409) isn't a failure, nor is one already gone; anything
  // else is, and goes in the cleanup's result.
  #removeImage(
    image: DockerImageSummary,
    kind: ImageRemovalKind
  ): Effect.Effect<{
    readonly error: string | null
    readonly removed: boolean
  }> {
    const attributes = { "cleanup.kind": kind }
    return this.#engine.removeImage(image.Id, { force: false }).pipe(
      Effect.andThen(
        Effect.all([
          Metric.update(Metric.withAttributes(imagesRemoved, attributes), 1),
          Metric.update(
            Metric.withAttributes(imageBytesRemoved, attributes),
            imageOwnBytes(image)
          ),
        ])
      ),
      Effect.as<RemovalOutcome>({ error: null, removed: true }),
      Effect.catchIf(isDockerNotFound, () =>
        Effect.succeed<RemovalOutcome>({ error: null, removed: true })
      ),
      Effect.catch((cause): Effect.Effect<RemovalOutcome> =>
        cause.status === 409
          ? Effect.logDebug("Docker kept an image", {
              error: cause.message,
              imageId: image.Id,
            }).pipe(Effect.as({ error: null, removed: false }))
          : Effect.logWarning("Docker didn't remove an image", {
              error: cause.message,
              imageId: image.Id,
            }).pipe(Effect.as({ error: errorMessage(cause), removed: false }))
      )
    )
  }

  // Unforced: Docker refuses one that started again since it was checked,
  // or that's already gone, which isn't a failure; anything else is.
  #removeSwept(
    containerId: string,
    kind: RemovalKind
  ): Effect.Effect<RemovalOutcome> {
    return this.#engine.removeContainer(containerId, { timeout: 90_000 }).pipe(
      Effect.andThen(count(removed, kind)),
      Effect.as({ error: null, removed: true }),
      Effect.catch((cause) =>
        count(refused, kind).pipe(
          Effect.andThen(
            Effect.logWarning("Docker didn't remove an update leftover", {
              containerId,
              error: cause.message,
              kind,
            })
          ),
          Effect.as({
            error:
              cause.status === 404 || cause.status === 409
                ? null
                : errorMessage(cause),
            removed: false,
          })
        )
      )
    )
  }

  #remove(containerId: string, volumes: boolean) {
    return this.#engine.removeContainer(containerId, {
      force: true,
      timeout: 90_000,
      volumes,
    })
  }
}

// A leftover's removal waits for the owner's power changes, as replacing
// its container did; one with no owner waits only for other cleanup.
function ownerLocks(
  owner: RelayDockerCleanupOwner | null
): ReadonlyArray<LaneLock> {
  switch (owner?.kind) {
    case "app":
      return appLifecycleLocks(owner.id)
    case "database":
      return databaseLifecycleLocks(owner.id)
    case "instance":
      return instanceLifecycleLocks(owner.id)
    case undefined:
      return [exclusive(laneKeys.dockerCleanup)]
  }
}

function errorMessage(cause: unknown): string {
  return (cause instanceof Error ? cause.message : String(cause)).slice(
    0,
    2_000
  )
}

function ownerKey(owner: KilnContainerOwner): string {
  return owner.resource.type === "relay"
    ? "relay"
    : `${owner.resource.type}:${owner.resource.id}`
}

function count(
  metric: Metric.Metric<number, unknown>,
  kind: RemovalKind
): Effect.Effect<void> {
  return Metric.update(
    Metric.withAttributes(metric, { "cleanup.kind": kind }),
    1
  )
}
