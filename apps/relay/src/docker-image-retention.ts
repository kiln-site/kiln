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
  readonly images: ReadonlyArray<DockerImageSummary>
  readonly now: number
  /** Whether a container is one of this Relay's Apps'. */
  readonly ownsApp: (container: DockerContainerSummary) => string | null
  /** The image Hearth and the Relay each ran before its latest update. */
  readonly previousKilnImages: ReadonlyMap<KilnComponent, string>
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
  const apps = new Set([
    ...facts.deployments.map((record) => record.appId),
    ...facts.containers.flatMap((container) => facts.ownsApp(container) ?? []),
  ])
  const lastUsed = new Map(
    facts.records.map((record) => [record.imageId, record.lastUsedAt])
  )
  const legacy = legacyBuilds(facts, apps)
  const removals: Array<ImageRemoval> = []
  const oldKiln = new Map<KilnComponent, Array<DockerImageSummary>>()
  for (const image of facts.images) {
    if (used.has(image.Id) || kept.has(image.Id)) continue
    const labels = image.Labels ?? {}
    const component = kilnComponent(labels["io.kiln.component"])
    if (component) {
      // One a tag still names may be pinned somewhere; it stays.
      if (!tagged(image)) {
        oldKiln.set(component, [...(oldKiln.get(component) ?? []), image])
      }
      continue
    }
    const appId = labels[APP_IMAGE_LABEL]
    if (appId && apps.has(appId)) {
      if (legacy.has(image.Id)) continue
      if (facts.now - (image.Created ?? 0) * 1000 < BUILD_GRACE_MS) continue
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
    for (const [component, candidates] of oldKiln) {
      const keep =
        candidates.find(
          (image) => image.Id === facts.previousKilnImages.get(component)
        ) ??
        candidates.reduce((newest, image) =>
          (image.Created ?? 0) > (newest.Created ?? 0) ? image : newest
        )
      for (const image of candidates) {
        if (image.Id !== keep.Id) {
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

// Builds from before deployments recorded their images: for an App with
// no record yet, its newest few stand in for its newest deployments'.
function legacyBuilds(facts: ImageFacts, apps: ReadonlySet<string>) {
  const recorded = new Set(facts.deployments.map((record) => record.appId))
  const builds = new Map<string, Array<DockerImageSummary>>()
  for (const image of facts.images) {
    const appId = image.Labels?.[APP_IMAGE_LABEL]
    if (!appId || !apps.has(appId) || recorded.has(appId)) continue
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

function tagged(image: DockerImageSummary): boolean {
  return (image.RepoTags ?? []).some((tag) => tag !== "<none>:<none>")
}

/** What removing an image would free, leaving out layers others share. */
export function imageOwnBytes(image: DockerImageSummary): number {
  return Math.max(0, (image.Size ?? 0) - Math.max(0, image.SharedSize ?? 0))
}
