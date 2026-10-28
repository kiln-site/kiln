import { minimatch } from "minimatch"

/**
 * Whether a backup leaves out a path, relative to what it backs up, by
 * gitignore-like patterns: the last that matches wins, and `!` keeps a path
 * an earlier pattern left out.
 */
export function backupPathIsExcluded(
  path: string,
  directory: boolean,
  patterns: ReadonlyArray<string>
): boolean {
  let excluded = false
  for (const rawPattern of patterns) {
    const trimmed = rawPattern.trim()
    if (!trimmed || trimmed.startsWith("#")) continue
    const negated = trimmed.startsWith("!")
    const pattern = negated ? trimmed.slice(1) : trimmed
    if (!pattern) continue
    const candidate = directory ? `${path}/` : path
    const matched = minimatch(candidate, pattern, {
      dot: true,
      matchBase: !pattern.includes("/"),
      nocase: false,
    })
    if (matched) excluded = !negated
  }
  return excluded
}
