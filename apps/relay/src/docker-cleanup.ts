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
  containerName,
  isDockerNotFound,
  type DockerContainerSummary,
  type DockerEngine,
  type DockerImageSummary,
} from "./docker-engine.js"
import type {
  RelayAppDeploymentImage,
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
} from "./operations/operation.js"
import {
  kilnContainerOwner,
  type KilnContainerOwner,
} from "./kiln-containers.js"
import {
  KILN_INSTALLATION_LABEL,
  kilnComponent,
  type KilnComponent,
} from "./update-container.js"

const UPDATE_HELPER_LABEL = "io.kiln.update-helper"
// What the update helper renames the container it replaces to, until the
// replacement is healthy (updater.ts).
const UPDATE_BACKUP_NAME = /^(.+)-kiln-backup-\d+$/u
// The label on images an App's Dockerfile builds (apps.ts).
const APP_IMAGE_LABEL = "kiln.app.id"
/** How many of an App's newest successful deployments keep their images. */
export const KEPT_APP_DEPLOYMENT_IMAGES = 5
// How long a build stays, so a failed deployment's can be looked into.
const BUILD_GRACE_SECONDS = 24 * 60 * 60
// How long an image nothing uses stays, so a game server deleted and made
// again, or a service turned off and on, doesn't download it again.
const UNUSED_IMAGE_GRACE_MS = 24 * 60 * 60_000
// Removals a pass makes at most, so one pass never holds cleanup long.
const IMAGES_PER_PASS = 50
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
type ImageKind = "app" | "kiln" | "unused"

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
  /** Whether an update this Relay started is still under way. */
  readonly updating: () => Effect.Effect<boolean>
  /** The image Hearth and the Relay each ran before its latest update. */
  readonly previousKilnImages: () => Effect.Effect<
    ReadonlyMap<KilnComponent, string>
  >
}

export class DockerCleanup {
  readonly #config: CleanupConfig
  readonly #engine: DockerEngine
  readonly #lanes: OperationLanes
  readonly #state: RelayStateStore["Service"]
  readonly #updating: () => Effect.Effect<boolean>
  readonly #previousKilnImages: DockerCleanupOptions["previousKilnImages"]

  constructor(options: DockerCleanupOptions) {
    this.#previousKilnImages = options.previousKilnImages
    this.#config = options.config
    this.#engine = options.engine
    this.#lanes = options.lanes
    this.#state = options.state
    this.#updating = options.updating
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

  /** Records the images a successful deployment runs. */
  recordDeployment(input: {
    readonly appId: string
    readonly deploymentId: string
    readonly imageIds: ReadonlyArray<string>
  }): Effect.Effect<void> {
    const state = this.#state
    return Clock.currentTimeMillis.pipe(
      Effect.flatMap((finishedAt) =>
        state.recordAppDeploymentImages({ ...input, finishedAt })
      ),
      Effect.catch((cause) =>
        Effect.logWarning("Relay couldn't record a deployment's images", cause)
      )
    )
  }

  /**
   * Removes the App's images that none of its newest successful
   * deployments runs, once they're a day old. Waits behind other cleanup,
   * but not for the App's next deployment.
   */
  pruneAppImages(appId: string): Effect.Effect<void> {
    return runOperation(this.#lanes, this.#pruneApp, appId, {
      kind: "worker",
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Relay couldn't remove an App's old images", cause)
      )
    )
  }

  /**
   * Removes what finished updates left, then tries each kept container
   * again in its owner's lane. Work in the way waits for the next pass.
   */
  pass(caller: RelayCaller): Effect.Effect<void> {
    const lanes = this.#lanes
    const state = this.#state
    const skipBusy = <A, E>(effect: Effect.Effect<A, E | LaneRejectedError>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchIf(
          (cause) => cause instanceof LaneRejectedError,
          () => Effect.void
        )
      )
    return Effect.gen({ self: this }, function* () {
      yield* skipBusy(
        runOperation(lanes, this.#sweepUpdates, undefined, caller)
      )
      const leftovers = yield* state.listDockerCleanups()
      for (const leftover of leftovers) {
        yield* skipBusy(
          runOperation(lanes, this.#retryRemoval, leftover, caller)
        )
      }
      yield* skipBusy(
        runOperation(lanes, this.#collectImages, undefined, caller)
      )
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Docker cleanup didn't finish", cause)
      )
    )
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
          }
          yield* Effect.sleep("5 minutes")
        }).pipe(Effect.forever)
      )
    )
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

  // Notes which images Kiln's containers use now, then removes those none
  // has used for a day. App builds and Hearth's and the Relay's images keep
  // to their own rules above; an image Kiln never ran isn't touched.
  readonly #collectImages = operation<void>()({
    name: "relay.docker.cleanup.images",
    locks: () => [exclusive(laneKeys.dockerCleanup)],
    onlyIfFree: true,
    run: () =>
      Effect.gen({ self: this }, function* () {
        const [containers, images] = yield* Effect.all(
          [
            this.#engine.listContainers({ all: true }),
            this.#engine.listImages(),
          ],
          { concurrency: 2 }
        )
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
        const [records, deployments] = yield* Effect.all([
          this.#state.listDockerImages(),
          this.#state.listAppDeploymentImages(),
        ])
        const kept = keptDeployments(deployments)
        const keptImages = new Set(
          deployments.flatMap((record) =>
            kept.has(deploymentKey(record)) ? [record.imageId] : []
          )
        )
        const used = usedImages(containers)
        const present = new Map(images.map((image) => [image.Id, image]))
        let removals = 0
        for (const record of records) {
          const image = present.get(record.imageId)
          if (!image) {
            yield* this.#state.forgetDockerImage(record.imageId)
            continue
          }
          if (used.has(image.Id) || keptImages.has(image.Id)) continue
          const labels = image.Labels ?? {}
          if (labels[APP_IMAGE_LABEL]) continue
          if (kilnComponent(labels["io.kiln.component"])) continue
          if (now - record.lastUsedAt < UNUSED_IMAGE_GRACE_MS) continue
          if (removals >= IMAGES_PER_PASS) break
          removals += 1
          if (yield* this.#removeImage(image, "unused")) {
            yield* this.#state.forgetDockerImage(image.Id)
          }
        }
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Relay couldn't remove unused images", cause)
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
          })
        ),
        Effect.ignore
      )
    },
  })

  // The helper of a finished update, and the container it set aside once
  // the replacement under its name runs. Nothing while any update runs:
  // a running helper may still roll back to the container it set aside.
  readonly #sweepUpdates = operation<void>()({
    name: "relay.docker.cleanup.updates",
    locks: () => [exclusive(laneKeys.dockerCleanup)],
    onlyIfFree: true,
    run: () =>
      Effect.gen({ self: this }, function* () {
        if (yield* this.#updating()) return
        const containers = yield* this.#engine.listContainers({ all: true })
        const helpers = containers.filter(
          (container) => container.Labels?.[UPDATE_HELPER_LABEL] === "true"
        )
        if (helpers.some((helper) => helper.State === "running")) return
        const byName = new Map(
          containers.map((container) => [containerName(container), container])
        )
        for (const helper of helpers) {
          yield* this.#removeSwept(helper.Id, "update-helper")
        }
        for (const container of containers) {
          if (container.State === "running") continue
          const original = UPDATE_BACKUP_NAME.exec(
            containerName(container)
          )?.[1]
          if (!original || byName.get(original)?.State !== "running") continue
          const labels = container.Labels ?? {}
          if (!kilnComponent(labels["io.kiln.component"])) continue
          const installation = labels[KILN_INSTALLATION_LABEL]
          if (installation && installation !== this.#config.installationId) {
            continue
          }
          yield* this.#removeSwept(container.Id, "update-backup")
        }
        yield* this.#pruneKilnImages(containers)
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Relay couldn't look for update leftovers", cause)
        )
      ),
  })

  // Beside the App's deployments, which take it shared too: a deployment
  // that finds an image it pulled gone pulls it again, and each build is
  // new. Its deletion, which removes its images itself, waits.
  readonly #pruneApp = operation<string>()({
    name: "relay.docker.cleanup.app-images",
    locks: ({ input }) => [
      exclusive(laneKeys.dockerCleanup),
      shared(laneKeys.app(input)),
    ],
    run: ({ input: appId }) =>
      Effect.gen({ self: this }, function* () {
        const [images, containers, records] = yield* Effect.all(
          [
            this.#engine.listImages(),
            this.#engine.listContainers({ all: true }),
            this.#state.listAppDeploymentImages(),
          ],
          { concurrency: 3 }
        )
        const now = yield* Clock.currentTimeMillis
        const kept = keptDeployments(records)
        const keptImages = new Set(
          records.flatMap((record) =>
            kept.has(deploymentKey(record)) ? [record.imageId] : []
          )
        )
        const used = usedImages(containers)
        const own = records.filter((record) => record.appId === appId)
        const recorded = new Set(own.map((record) => record.imageId))
        const built = images.filter(
          (image) => image.Labels?.[APP_IMAGE_LABEL] === appId
        )
        // Builds from before deployments recorded their images: the newest
        // few stand in for them until the App has a record.
        const legacy = new Set(
          own.length > 0
            ? []
            : [...built]
                .sort(
                  (left, right) => (right.Created ?? 0) - (left.Created ?? 0)
                )
                .slice(0, KEPT_APP_DEPLOYMENT_IMAGES)
                .map((image) => image.Id)
        )
        for (const image of images) {
          const isBuild = image.Labels?.[APP_IMAGE_LABEL] === appId
          if (!isBuild && !recorded.has(image.Id)) continue
          if (used.has(image.Id) || keptImages.has(image.Id)) continue
          if (isBuild) {
            if (legacy.has(image.Id)) continue
            if (now / 1000 - (image.Created ?? 0) < BUILD_GRACE_SECONDS) {
              continue
            }
          } else if (tagged(image)) {
            // A pulled image its tag still names may be anyone's.
            continue
          }
          yield* this.#removeImage(image, "app")
        }
        yield* this.#state.forgetAppDeploymentImages(appId, [
          ...new Set(
            own.flatMap((record) =>
              kept.has(deploymentKey(record)) ? [] : [record.deploymentId]
            )
          ),
        ])
      }),
  })

  // Hearth's and the Relay's old images, once no tag names them: each keeps
  // the one it ran before its latest update, or, without a record of it,
  // the newest. Only while no update runs, as a rollback needs the old one.
  #pruneKilnImages(
    containers: ReadonlyArray<DockerContainerSummary>
  ): Effect.Effect<void, unknown> {
    return Effect.gen({ self: this }, function* () {
      const [images, previous] = yield* Effect.all([
        this.#engine.listImages({ filters: { label: ["io.kiln.component"] } }),
        this.#previousKilnImages(),
      ])
      const used = usedImages(containers)
      const unused = new Map<KilnComponent, Array<DockerImageSummary>>()
      for (const image of images) {
        const component = kilnComponent(image.Labels?.["io.kiln.component"])
        if (!component || used.has(image.Id) || tagged(image)) continue
        unused.set(component, [...(unused.get(component) ?? []), image])
      }
      for (const [component, candidates] of unused) {
        const keep =
          candidates.find((image) => image.Id === previous.get(component)) ??
          candidates.reduce((newest, image) =>
            (image.Created ?? 0) > (newest.Created ?? 0) ? image : newest
          )
        for (const image of candidates) {
          if (image.Id !== keep.Id) yield* this.#removeImage(image, "kiln")
        }
      }
    })
  }

  // Unforced, so Docker keeps one a container started using meanwhile.
  // Whether it's gone.
  #removeImage(
    image: DockerImageSummary,
    kind: ImageKind
  ): Effect.Effect<boolean> {
    const attributes = { "cleanup.kind": kind }
    return this.#engine.removeImage(image.Id, { force: false }).pipe(
      Effect.andThen(
        Effect.all([
          Metric.update(Metric.withAttributes(imagesRemoved, attributes), 1),
          Metric.update(
            Metric.withAttributes(imageBytesRemoved, attributes),
            Math.max(image.Size ?? 0, 0)
          ),
        ])
      ),
      Effect.as(true),
      Effect.catchIf(isDockerNotFound, () => Effect.succeed(true)),
      Effect.catch((cause) =>
        Effect.logDebug("Docker kept an image", {
          error: cause.message,
          imageId: image.Id,
        }).pipe(Effect.as(false))
      )
    )
  }

  #removeSwept(containerId: string, kind: RemovalKind): Effect.Effect<void> {
    return this.#remove(containerId, false).pipe(
      Effect.andThen(count(removed, kind)),
      Effect.catch((cause) =>
        count(refused, kind).pipe(
          Effect.andThen(
            Effect.logWarning("Docker didn't remove an update leftover", {
              containerId,
              error: cause.message,
              kind,
            })
          )
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

// Each App's newest successful deployments, by `deploymentKey`.
function keptDeployments(
  records: ReadonlyArray<RelayAppDeploymentImage>
): Set<string> {
  const finished = new Map<string, Map<string, number>>()
  for (const record of records) {
    const deployments = finished.get(record.appId) ?? new Map()
    deployments.set(record.deploymentId, record.finishedAt)
    finished.set(record.appId, deployments)
  }
  const kept = new Set<string>()
  for (const [appId, deployments] of finished) {
    for (const [deploymentId] of [...deployments]
      .sort((left, right) => right[1] - left[1])
      .slice(0, KEPT_APP_DEPLOYMENT_IMAGES)) {
      kept.add(deploymentKey({ appId, deploymentId }))
    }
  }
  return kept
}

function deploymentKey(record: {
  readonly appId: string
  readonly deploymentId: string
}): string {
  return `${record.appId}/${record.deploymentId}`
}

// Images any container uses, running or not, Kiln's or anyone's.
function usedImages(
  containers: ReadonlyArray<DockerContainerSummary>
): Set<string> {
  return new Set(containers.flatMap((container) => container.ImageID ?? []))
}

function tagged(image: DockerImageSummary): boolean {
  return (image.RepoTags ?? []).some((tag) => tag !== "<none>:<none>")
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
