import {
  compareKilnReleaseVersions,
  isKilnNightlyVersion,
  isKilnReleaseVersion,
  kilnReleaseVersionCore,
} from "@workspace/contracts"

export { isKilnReleaseVersion }

type ReleaseVersionMetadata = {
  aliases?: ReadonlyArray<string>
  publishedAt: string | null
  version: string
}

export function compareReleaseVersions(
  left: string,
  right: string | null,
  publishedAtByVersion: ReadonlyMap<string, string | null>
): -1 | 0 | 1 {
  if (!right) return 1
  if (left === right) return 0
  const semanticComparison = compareKilnReleaseVersions(left, right)
  if (semanticComparison === null) return 0
  if (
    kilnReleaseVersionCore(left) !== kilnReleaseVersionCore(right) ||
    isKilnNightlyVersion(left) === isKilnNightlyVersion(right)
  ) {
    return semanticComparison
  }

  return (
    comparePublishedAt(
      publishedAtByVersion.get(left),
      publishedAtByVersion.get(right)
    ) ?? semanticComparison
  )
}

export function orderKilnReleases<TRelease extends ReleaseVersionMetadata>(
  releases: ReadonlyArray<TRelease>
): Array<TRelease> {
  const publishedAtByVersion = new Map(
    releases.map((release) => [release.version, release.publishedAt])
  )
  return [...releases].sort((left, right) =>
    invertOrder(
      compareReleaseVersions(left.version, right.version, publishedAtByVersion)
    )
  )
}

export function compareLatestReleaseVersion(
  currentVersion: string | null,
  releases: ReadonlyArray<ReleaseVersionMetadata>
): -1 | 0 | 1 | null {
  const orderedReleases = orderKilnReleases(releases)
  const latestRelease = orderedReleases[0]
  if (!latestRelease || !isKilnReleaseVersion(currentVersion)) return null
  const currentRelease = findKilnRelease(releases, currentVersion)
  const canonicalCurrentVersion = currentRelease?.version ?? currentVersion
  if (latestRelease.version === canonicalCurrentVersion) return 0

  const publishedAtByVersion = new Map(
    orderedReleases.map((release) => [release.version, release.publishedAt])
  )
  const comparison = compareReleaseVersions(
    latestRelease.version,
    canonicalCurrentVersion,
    publishedAtByVersion
  )

  // The feed's first entry is authoritative for the latest-only policy. A
  // stable and nightly build can share a numeric version even when the older
  // build is no longer present in GitHub's retained release window.
  if (
    comparison === -1 &&
    kilnReleaseVersionCore(latestRelease.version) ===
      kilnReleaseVersionCore(canonicalCurrentVersion)
  ) {
    return 1
  }
  return comparison
}

export function findKilnRelease<
  TRelease extends Pick<ReleaseVersionMetadata, "aliases" | "version">,
>(
  releases: ReadonlyArray<TRelease>,
  version: string | null
): TRelease | null {
  if (!version) return null
  return (
    releases.find(
      (release) =>
        release.version === version || release.aliases?.includes(version)
    ) ?? null
  )
}

type ReleaseLabelMetadata = {
  aliases?: ReadonlyArray<string>
  name: string
  version: string
}

/** Human release name, e.g. "v0.1.0 Nightly #123", for a reported version. */
export function kilnReleaseLabel(
  version: string,
  releases: ReadonlyArray<ReleaseLabelMetadata>
): string {
  const release = findKilnRelease(releases, version)
  if (release) return release.name
  if (!isKilnReleaseVersion(version)) return version
  const core = kilnReleaseVersionCore(version)
  if (!isKilnNightlyVersion(version)) return `v${core}`
  const sequence = /-nightly\.(\d+)$/u.exec(version)?.[1]
  return sequence ? `v${core} Nightly #${sequence}` : `v${core} Nightly`
}

function comparePublishedAt(
  left: string | null | undefined,
  right: string | null | undefined
): -1 | 0 | 1 | null {
  if (!left || !right) return null
  const leftTime = Date.parse(left)
  const rightTime = Date.parse(right)
  if (!Number.isFinite(leftTime) || !Number.isFinite(rightTime)) return null
  return compareNumbers(leftTime, rightTime)
}

function compareNumbers(left: number, right: number): -1 | 0 | 1 {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function invertOrder(order: -1 | 0 | 1): -1 | 0 | 1 {
  if (order === 0) return 0
  return order === 1 ? -1 : 1
}
