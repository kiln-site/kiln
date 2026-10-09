export type ReleaseChangeGroup = "new" | "improved" | "fixed" | "other"

export type ReleaseChange = {
  group: ReleaseChangeGroup
  key: string
  pullRequest: number | null
  scope: string | null
  title: string
}

export type ParsedReleaseNotes = {
  changes: Array<ReleaseChange>
  hiddenCount: number
}

// Conventional commit types from PR titles. `null` hides maintenance work
// that never reaches someone running Kiln.
const groupByType: Readonly<Record<string, ReleaseChangeGroup | null>> = {
  build: null,
  chore: null,
  ci: null,
  docs: null,
  feat: "new",
  fix: "fixed",
  perf: "improved",
  refactor: null,
  revert: "fixed",
  style: null,
  test: null,
  ui: "improved",
}

// GitHub's generated notes: `* type(scope): title by @user in <pull URL>`.
const changePattern =
  /^([a-z]+)(?:\(([^)]*)\))?!?:\s+(.+?)(?:\s+by\s+@[\w-]+(?:\[bot\])?)?(?:\s+in\s+(?:https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+)|#(\d+)))?$/u

/**
 * The changes a release lists, in order. Maintenance work (CI, docs, tests)
 * is only counted. A change listed twice appears once.
 */
export function parseReleaseNotes(note: string | null): ParsedReleaseNotes {
  const changes: Array<ReleaseChange> = []
  const seen = new Set<string>()
  let hiddenCount = 0

  for (const rawLine of (note ?? "").replaceAll("\r", "").split("\n")) {
    const line = rawLine.trim()
    if (!/^[-*+]\s+/u.test(line)) continue
    const text = line.replace(/^[-*+]\s+/u, "").trim()
    if (!text || /\bmade their first contribution\b/iu.test(text)) continue

    const match = text.match(changePattern)
    const type = match?.[1]?.toLowerCase()
    const group =
      type !== undefined && type in groupByType ? groupByType[type] : "other"
    const pullRequestText = match?.[4] ?? match?.[5]
    const pullRequest = pullRequestText ? Number(pullRequestText) : null
    const key = pullRequest ? `pr:${pullRequest}` : `text:${text}`
    if (seen.has(key)) continue
    seen.add(key)

    if (group === null) {
      hiddenCount += 1
      continue
    }
    changes.push({
      group,
      key,
      pullRequest,
      scope: group === "other" ? null : match?.[2]?.trim() || null,
      title: group === "other" ? text : capitalize(match?.[3] ?? text),
    })
  }

  return { changes, hiddenCount }
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}
