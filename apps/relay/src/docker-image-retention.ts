/**
 * Which images on the host Kiln may remove, and why: the rules every image
 * cleanup follows, whether a pass, an App's deployment finishing, or a
 * person asking (docker-cleanup.ts). An image any container uses, even a
 * stopped one or a person's own, is never removed.
 */
import type {
  DockerContainerSummary,
  DockerImageSummary,
} from "./docker-engine.js"
import type {
  RelayAppDeploymentImage,
  RelayDockerImageRecord,
} from "./effect/state.js"
import { kilnComponent, type KilnComponent } from "./update-container.js"

/** The label on images an App's Dockerfile builds (apps.ts). */
export const APP_IMAGE_LABEL = "kiln.app.id"
/** How many of an App's newest successful deployments keep their images. */
export const KEPT_APP_DEPLOYMENTS = 5
// How long a build stays, so a failed deployment's can be looked into.
const BUILD_GRACE_MS = 24 * 60 * 60_000

export interface ImageFacts {
  readonly containers: ReadonlyArray<DockerContainerSummary>
  /** The images each App's successful deployments ran. */
  readonly deployments: ReadonlyArray<RelayAppDeploymentImage>
  /** The image the desktop runs, by ID: a Mac has to wait to get it back. */
  readonly desktopImageId: string | null
  readonly images: ReadonlyArray<DockerImageSummary>
  readonly now: number
  /** Whether a container is one of this Relay's Apps'. */
  readonly ownsApp: (container: DockerContainerSummary) => string | null
  /**
   * Hearth and Relay images this Relay's updates named, by ID or digest,
   * and those of them to keep: a running update's, and each component's
   * from before its latest successful update.
   */
  readonly kilnUpdates: {
    readonly kept: ReadonlySet<string>
    readonly named: ReadonlySet<string>
  }
  /** The images Kiln's containers ran, and when one last did. */
  readonly records: ReadonlyArray<RelayDockerImageRecord>
}

export interface RetentionRules {
  /** How long an image no Kiln container uses stays. */
  readonly unusedGraceMs: number
  /** Whether Hearth's and the Relay's old images may go: not mid-update. */
  readonly kilnImages: boolean
  /** Whether unused images Kiln never ran go too, as a person may ask. */
  readonly unknownImages: boolean
}

/**
 * - `app`: a build for one of this Relay's Apps that none of its newest
 *   successful deployments runs, a day old.
 * - `kiln`: an old Hearth or Relay image no tag names, but the one each ran
 *   before its latest update.
 * - `unused`: one Kiln's containers ran, and none has for the grace.
 * - `unknown`: one no Kiln container ran, removed only when asked.
 */
export type ImageRemovalKind = "app" | "kiln" | "unknown" | "unused"

export interface ImageRemoval {
  readonly image: DockerImageSummary
  readonly kind: ImageRemovalKind
  /** The App a build was for. */
  readonly appId: string | null
}

export function removableImages(
  facts: ImageFacts,
  rules: RetentionRules
): Array<ImageRemoval> {
  const used = new Set(
    facts.containers.flatMap((container) => container.ImageID ?? [])
  )
  const kept = keptDeploymentImages(facts.deployments)
  // An App this Relay deployed, runs, or built for, even one whose first
  // deployment failed.
  const apps = new Set([
    ...facts.deployments.map((record) => record.appId),
    ...facts.containers.flatMap((container) => facts.ownsApp(container) ?? []),
    ...facts.records.flatMap((record) =>
      record.owner.startsWith("app:") ? [record.owner.slice("app:".length)] : []
    ),
  ])
  const lastUsed = new Map(
    facts.records.map((record) => [record.imageId, record.lastUsedAt])
  )
  const legacy = legacyBuilds(facts, apps, lastUsed)
  const removals: Array<ImageRemoval> = []
  const oldKiln = new Map<KilnComponent, Array<DockerImageSummary>>()
  for (const image of facts.images) {
    if (used.has(image.Id) || kept.has(image.Id)) continue
    if (image.Id === facts.desktopImageId) continue
    const labels = image.Labels ?? {}
    const component = kilnComponent(labels["io.kiln.component"])
    if (component) {
      // Only one this Relay's updates named or its containers ran: another
      // installation on the host keeps its own. One a tag still names may
      // be pinned somewhere; it stays.
      const own =
        lastUsed.has(image.Id) || matches(image, facts.kilnUpdates.named)
      if (own && !tagged(image)) {
        oldKiln.set(component, [...(oldKiln.get(component) ?? []), image])
      }
      continue
    }
    const appId = labels[APP_IMAGE_LABEL]
    if (appId && apps.has(appId)) {
      if (legacy.has(image.Id)) continue
      // A build Docker took from its cache keeps the first one's time, so
      // when it was last built counts too.
      const built = Math.max(
        (image.Created ?? 0) * 1000,
        lastUsed.get(image.Id) ?? 0
      )
      if (facts.now - built < BUILD_GRACE_MS) continue
      removals.push({ appId, image, kind: "app" })
      continue
    }
    const last = lastUsed.get(image.Id)
    if (last !== undefined) {
      if (facts.now - last >= rules.unusedGraceMs) {
        removals.push({ appId: null, image, kind: "unused" })
      }
      continue
    }
    if (rules.unknownImages) {
      removals.push({ appId: null, image, kind: "unknown" })
    }
  }
  if (rules.kilnImages) {
    // Components whose kept image is on the host, even one a tag or a
    // container keeps anyway.
    const recorded = new Set(
      facts.images.flatMap((image) => {
        const component = kilnComponent(image.Labels?.["io.kiln.component"])
        return component && matches(image, facts.kilnUpdates.kept)
          ? [component]
          : []
      })
    )
    for (const [component, candidates] of oldKiln) {
      // Without a record of the image before the latest update, the newest
      // stands in for it.
      const keep = new Set(
        (recorded.has(component)
          ? candidates.filter((image) => matches(image, facts.kilnUpdates.kept))
          : [
              candidates.reduce((newest, image) =>
                (image.Created ?? 0) > (newest.Created ?? 0) ? image : newest
              ),
            ]
        ).map((image) => image.Id)
      )
      for (const image of candidates) {
        if (!keep.has(image.Id)) {
          removals.push({ appId: null, image, kind: "kiln" })
        }
      }
    }
  }
  return removals
}

/** Each App's newest successful deployments, as `appId/deploymentId`. */
export function keptDeployments(
  deployments: ReadonlyArray<RelayAppDeploymentImage>
): Set<string> {
  const finished = new Map<string, Map<string, number>>()
  for (const record of deployments) {
    const app = finished.get(record.appId) ?? new Map<string, number>()
    app.set(record.deploymentId, record.finishedAt)
    finished.set(record.appId, app)
  }
  const kept = new Set<string>()
  for (const [appId, app] of finished) {
    for (const [deploymentId] of [...app]
      .sort((left, right) => right[1] - left[1])
      .slice(0, KEPT_APP_DEPLOYMENTS)) {
      kept.add(`${appId}/${deploymentId}`)
    }
  }
  return kept
}

function keptDeploymentImages(
  deployments: ReadonlyArray<RelayAppDeploymentImage>
): Set<string> {
  const kept = keptDeployments(deployments)
  return new Set(
    deployments.flatMap((record) =>
      kept.has(`${record.appId}/${record.deploymentId}`) ? [record.imageId] : []
    )
  )
}

// Builds from before Relays recorded builds and deployments' images: for
// an App with no deployment record yet, its newest few unrecorded builds
// stand in for its newest deployments'.
function legacyBuilds(
  facts: ImageFacts,
  apps: ReadonlySet<string>,
  recordedImages: ReadonlyMap<string, number>
) {
  const recorded = new Set(facts.deployments.map((record) => record.appId))
  const builds = new Map<string, Array<DockerImageSummary>>()
  for (const image of facts.images) {
    const appId = image.Labels?.[APP_IMAGE_LABEL]
    if (!appId || !apps.has(appId) || recorded.has(appId)) continue
    if (recordedImages.has(image.Id)) continue
    builds.set(appId, [...(builds.get(appId) ?? []), image])
  }
  return new Set(
    [...builds.values()].flatMap((images) =>
      images
        .sort((left, right) => (right.Created ?? 0) - (left.Created ?? 0))
        .slice(0, KEPT_APP_DEPLOYMENTS)
        .map((image) => image.Id)
    )
  )
}

// Whether one of `references` names the image, by its ID or a digest it
// was pulled as.
function matches(
  image: DockerImageSummary,
  references: ReadonlySet<string>
): boolean {
  return (
    references.has(image.Id) ||
    (image.RepoDigests ?? []).some((digest) => references.has(digest))
  )
}

function tagged(image: DockerImageSummary): boolean {
  return (image.RepoTags ?? []).some((tag) => tag !== "<none>:<none>")
}

/** What removing an image would free, leaving out layers others share. */
export function imageOwnBytes(image: DockerImageSummary): number {
  return Math.max(0, (image.Size ?? 0) - Math.max(0, image.SharedSize ?? 0))
}
