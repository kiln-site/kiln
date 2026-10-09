import type { ChangelogRelease } from "@/effect/kiln-release-feed"
import type { ReleaseChange } from "@/lib/release-notes"

export type ChangelogMarker = {
  component: "hearth" | "relay"
  key: string
  name: string
  state: "current" | "previous"
  version: string
}

export type ChangelogTimelineItem =
  | {
      kind: "version"
      key: string
      latest: boolean
      markers: ReadonlyArray<ChangelogMarker>
      release: ChangelogRelease
    }
  | { kind: "earlier"; key: string }
  | { kind: "day"; key: string; label: string }
  | {
      kind: "change"
      key: string
      change: ReleaseChange
      release: ChangelogRelease
    }
  | { kind: "quiet"; key: string; hiddenCount: number }

export type ChangelogTimeline = {
  items: Array<ChangelogTimelineItem>
  // Where each marked component's version line sits, by marker key.
  markerIndexes: ReadonlyMap<string, number>
  missingMarkers: number
}

const dayFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "short",
  weekday: "short",
})

/**
 * Lays releases, newest first, out as a timeline. Only the latest release and
 * the ones a Panel or Relay runs or ran before get a version line; the
 * releases between two lines merge into the line above, since that's what
 * updating across them brings. Releases older than the oldest line follow
 * under "Earlier", grouped by day.
 */
export function changelogTimeline(
  releases: ReadonlyArray<ChangelogRelease>,
  markers: ReadonlyArray<ChangelogMarker>
): ChangelogTimeline {
  const markersByIndex = new Map<number, Array<ChangelogMarker>>()
  let found = 0
  for (const marker of markers) {
    const index = releases.findIndex(
      (release) =>
        release.version === marker.version ||
        release.aliases.includes(marker.version)
    )
    if (index < 0) continue
    found += 1
    const list = markersByIndex.get(index) ?? []
    list.push(marker)
    markersByIndex.set(index, list)
  }
  const lineIndexes = [
    ...new Set([...(releases.length > 0 ? [0] : []), ...markersByIndex.keys()]),
  ].sort((left, right) => left - right)
  const oldestLine = lineIndexes.at(-1) ?? -1

  const items: Array<ChangelogTimelineItem> = []
  const markerIndexes = new Map<string, number>()
  let day: string | null = null

  // Version lines carry their own time, so only "Earlier" is split by day.
  const pushChanges = (release: ChangelogRelease, byDay: boolean) => {
    const visible = release.changes
    if (visible.length === 0) return 0
    const label = formatDay(release.publishedAt)
    if (byDay && label !== day) {
      day = label
      items.push({ key: `day:${release.tag}`, kind: "day", label })
    }
    for (const change of visible) {
      items.push({
        change,
        key: `change:${release.tag}:${change.key}`,
        kind: "change",
        release,
      })
    }
    return visible.length
  }

  lineIndexes.forEach((lineIndex, position) => {
    const release = releases[lineIndex]
    if (!release) return
    // The oldest line covers only its own release; the rest is "Earlier".
    const end =
      lineIndex === oldestLine
        ? lineIndex + 1
        : (lineIndexes[position + 1] ?? releases.length)
    const lineMarkers = markersByIndex.get(lineIndex) ?? []
    for (const marker of lineMarkers)
      markerIndexes.set(marker.key, items.length)
    items.push({
      key: `version:${release.tag}`,
      kind: "version",
      latest: lineIndex === 0,
      markers: lineMarkers,
      release,
    })
    let shown = 0
    let hiddenCount = 0
    for (let index = lineIndex; index < end; index += 1) {
      const covered = releases[index]
      if (!covered) continue
      shown += pushChanges(covered, false)
      hiddenCount += covered.hiddenCount
    }
    if (shown === 0) {
      items.push({ hiddenCount, key: `quiet:${release.tag}`, kind: "quiet" })
    }
  })

  if (oldestLine + 1 < releases.length) {
    items.push({ key: "earlier", kind: "earlier" })
    day = null
    for (let index = oldestLine + 1; index < releases.length; index += 1) {
      const release = releases[index]
      if (release) pushChanges(release, true)
    }
  }

  return { items, markerIndexes, missingMarkers: markers.length - found }
}

function formatDay(publishedAt: string | null): string {
  if (!publishedAt) return "Undated"
  const date = new Date(publishedAt)
  return Number.isFinite(date.getTime()) ? dayFormatter.format(date) : "Undated"
}
