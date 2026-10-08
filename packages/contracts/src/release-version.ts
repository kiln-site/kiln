// CI imports this module directly before installing dependencies. Keep it package-free.
export type KilnReleaseVersionOrder = -1 | 0 | 1

type ParsedKilnReleaseVersion = {
  core: readonly [number, number, number]
  nightly:
    | {
        kind: "legacy"
        sequence: number
      }
    | {
        date: number
        kind: "timestamp"
        time: number
      }
    | null
}

const kilnReleaseVersionPattern =
  /^(\d+)\.(\d+)\.(\d+)(?:-nightly\.(?:(\d{8})\.(\d{6})|(\d+)))?$/u
const nightlyVersionSuffixPattern = /-nightly\.(?:\d{8}\.\d{6}|\d+)$/u

export function isKilnReleaseVersion(
  version: string | null | undefined
): version is string {
  return (
    version !== null &&
    version !== undefined &&
    parseKilnReleaseVersion(version.trim()) !== null
  )
}

export function isKilnNightlyVersion(version: string): boolean {
  const parsedVersion = parseKilnReleaseVersion(version)
  return parsedVersion !== null && parsedVersion.nightly !== null
}

export function kilnReleaseVersionCore(version: string): string {
  return version.replace(nightlyVersionSuffixPattern, "")
}

/** Docker label holding the CI run number a release image was built by. */
export const kilnReleaseNumberLabel = "io.kiln.release-number"
/** Docker label holding the display name of the release a container runs. */
export const kilnReleaseNameLabel = "io.kiln.release-name"

/**
 * Display name GitHub releases use, e.g. "v0.1.0" or "v0.1.0 Nightly #123".
 * Versions that are not Kiln releases, such as development builds, are kept.
 */
export function kilnReleaseName(
  version: string,
  releaseNumber?: string | null
): string {
  const parsedVersion = parseKilnReleaseVersion(version)
  if (!parsedVersion) return version
  const core = `v${parsedVersion.core.join(".")}`
  if (!parsedVersion.nightly) return core
  const runNumber = releaseNumber?.trim() ?? ""
  const number = /^\d+$/u.test(runNumber)
    ? runNumber
    : parsedVersion.nightly.kind === "legacy"
      ? String(parsedVersion.nightly.sequence)
      : null
  return number ? `${core} Nightly #${number}` : `${core} Nightly`
}

export function compareKilnReleaseVersions(
  left: string,
  right: string
): KilnReleaseVersionOrder | null {
  const leftVersion = parseKilnReleaseVersion(left)
  const rightVersion = parseKilnReleaseVersion(right)
  if (!leftVersion || !rightVersion) return null

  for (let index = 0; index < leftVersion.core.length; index += 1) {
    const difference =
      (leftVersion.core[index] ?? 0) - (rightVersion.core[index] ?? 0)
    if (difference !== 0) return difference < 0 ? -1 : 1
  }

  if (leftVersion.nightly !== null && rightVersion.nightly !== null) {
    if (leftVersion.nightly.kind !== rightVersion.nightly.kind) {
      return leftVersion.nightly.kind === "timestamp" ? 1 : -1
    }
    if (
      leftVersion.nightly.kind === "legacy" &&
      rightVersion.nightly.kind === "legacy"
    ) {
      return compareNumbers(
        leftVersion.nightly.sequence,
        rightVersion.nightly.sequence
      )
    }
    if (
      leftVersion.nightly.kind === "timestamp" &&
      rightVersion.nightly.kind === "timestamp"
    ) {
      const dateOrder = compareNumbers(
        leftVersion.nightly.date,
        rightVersion.nightly.date
      )
      return dateOrder === 0
        ? compareNumbers(leftVersion.nightly.time, rightVersion.nightly.time)
        : dateOrder
    }
  }
  if (leftVersion.nightly === null && rightVersion.nightly === null) return 0
  return leftVersion.nightly === null ? 1 : -1
}

function parseKilnReleaseVersion(
  version: string
): ParsedKilnReleaseVersion | null {
  const match = kilnReleaseVersionPattern.exec(version.trim())
  if (!match) return null
  const nightly =
    match[4] !== undefined && match[5] !== undefined
      ? parseTimestampNightly(match[4], match[5])
      : match[6] === undefined
        ? null
        : { kind: "legacy" as const, sequence: Number(match[6]) }
  if (match[4] !== undefined && nightly === null) return null
  return {
    core: [Number(match[1] ?? 0), Number(match[2] ?? 0), Number(match[3] ?? 0)],
    nightly,
  }
}

function parseTimestampNightly(
  dateIdentifier: string,
  timeIdentifier: string
): ParsedKilnReleaseVersion["nightly"] {
  const year = Number(dateIdentifier.slice(0, 4))
  const month = Number(dateIdentifier.slice(4, 6))
  const day = Number(dateIdentifier.slice(6, 8))
  const hour = Number(timeIdentifier.slice(0, 2))
  const minute = Number(timeIdentifier.slice(2, 4))
  const second = Number(timeIdentifier.slice(4, 6))
  const timestamp = Date.UTC(year, month - 1, day, hour, minute, second)
  const date = new Date(timestamp)
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  ) {
    return null
  }
  return {
    date: Number(dateIdentifier),
    kind: "timestamp",
    time: Number(timeIdentifier),
  }
}

function compareNumbers(left: number, right: number): KilnReleaseVersionOrder {
  if (left === right) return 0
  return left < right ? -1 : 1
}
