import type { RelayInstanceImageCheckResult } from "@workspace/contracts"
import { Effect, Result, Semaphore } from "effect"

import { isDockerNotFound, type DockerEngine } from "./docker-engine.js"
import {
  normalizedReference,
  parseImageReference,
  repositoryName,
  type ImageReference,
} from "./docker-reference.js"

// Whether a game server's or a database's image tag names a newer image
// than its container runs. Each runs the tag its container was made from,
// which deploying again pulls, so what it runs is the digests Docker
// recorded when it pulled that image. An App deployed at a digest Kiln
// chose has its own check, in its driver.

/** The container an instance runs in, or null while it has none. */
export interface ImageCheckSubject {
  /** The Brick it was installed from, which every answer says. */
  brick?: { revision: number; source: string } | undefined
  container: {
    /** The image it is set up to run, as a deploy would pull it. */
    image: string
    /** The image it runs, by ID. */
    imageId: string | null
  } | null
  id: string
}

/** Registries are asked four at a time, across every kind's checks. */
export const registryLookups = Semaphore.makeUnsafe(4)

/**
 * Which revision of its Brick a container's labels say it was installed
 * from. One made before Bricks had revisions was installed from the first.
 */
export function installedRevision(
  labels: Record<string, string | undefined>
): number {
  const revision = Number(labels["kiln.brick.revision"])
  return Number.isInteger(revision) && revision >= 1 ? revision : 1
}

/**
 * The digests an image was pulled as from a repository: what a container
 * runs, when Kiln didn't record the digest it deployed.
 */
export async function repositoryDigests(
  engine: DockerEngine,
  imageId: string | null,
  reference: ImageReference,
  signal?: AbortSignal
): Promise<Array<string>> {
  if (!imageId) return []
  const image = await Effect.runPromise(
    engine
      .inspectImage<{ RepoDigests?: Array<string> | null } | null>(imageId)
      .pipe(Effect.catchIf(isDockerNotFound, () => Effect.succeed(null))),
    { signal }
  )
  const repository = repositoryName(reference)
  return (image?.RepoDigests ?? []).flatMap((entry) => {
    const parsed = Result.try(() => parseImageReference(entry))
    return Result.isSuccess(parsed) &&
      parsed.success.digest !== undefined &&
      repositoryName(parsed.success) === repository
      ? [parsed.success.digest]
      : []
  })
}

/**
 * What each container's tag names in its registry now, against what the
 * container runs. Containers naming the same image share one lookup.
 */
export async function checkContainerImages(
  engine: DockerEngine,
  subjects: ReadonlyArray<ImageCheckSubject>,
  signal?: AbortSignal
): Promise<Array<RelayInstanceImageCheckResult>> {
  const checks = subjects.map(({ brick, container, id }) => {
    const reference = container
      ? Result.try(() => parseImageReference(container.image))
      : null
    return { brick, container, id, reference }
  })
  const wanted = new Set(
    checks.flatMap(({ reference }) =>
      reference &&
      Result.isSuccess(reference) &&
      reference.success.digest === undefined
        ? [normalizedReference(reference.success)]
        : []
    )
  )
  const latest = new Map(
    await Effect.runPromise(
      Effect.forEach(
        [...wanted],
        (name) =>
          registryLookups
            .withPermits(1)(engine.distributionDigest(name))
            .pipe(
              Effect.result,
              Effect.map((result) => [name, result] as const)
            ),
        { concurrency: "unbounded" }
      ),
      { signal }
    )
  )
  const imageAnswer = async ({
    container,
    id,
    reference,
  }: Omit<
    (typeof checks)[number],
    "brick"
  >): Promise<RelayInstanceImageCheckResult> => {
    if (!container || !reference) return { id, status: "not_deployed" }
    if (Result.isFailure(reference)) {
      return {
        error: "The image isn't a valid reference",
        id,
        status: "error",
      }
    }
    if (reference.success.digest !== undefined) {
      return { id, status: "pinned" }
    }
    const found = latest.get(normalizedReference(reference.success))
    if (!found) return { id, status: "changed" }
    if (Result.isFailure(found)) {
      return {
        error: found.failure.reason.slice(0, 500),
        id,
        status: "error",
      }
    }
    return {
      id,
      image: container.image,
      latestDigest: found.success,
      runningDigests: await repositoryDigests(
        engine,
        container.imageId,
        reference.success,
        signal
      ),
      status: "checked",
    }
  }
  return Promise.all(
    checks.map(async ({ brick, ...check }) => ({
      ...(await imageAnswer(check)),
      ...(brick && { brick }),
    }))
  )
}
