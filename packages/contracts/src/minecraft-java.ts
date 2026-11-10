function parseMinecraftVersion(
  version: string
): readonly [major: number, minor: number, patch: number] | null {
  const match = version.trim().match(/^(\d+)\.(\d+)(?:\.(\d+))?$/u)
  if (!match?.[1] || !match[2]) return null
  const major = Number(match[1])
  const minor = Number(match[2])
  const patch = Number(match[3] ?? 0)
  return [major, minor, patch].every(Number.isSafeInteger)
    ? [major, minor, patch]
    : null
}

export function latestVelocityVersion(
  versions: ReadonlyArray<string>
): string | null {
  const parsed = versions.flatMap((version) => {
    const value = version.trim()
    const parts = parseMinecraftVersion(value.replace(/-SNAPSHOT$/u, ""))
    return parts ? [{ value, parts }] : []
  })
  parsed.sort((left, right) => {
    for (let index = 0; index < 3; index += 1) {
      const difference = right.parts[index]! - left.parts[index]!
      if (difference) return difference
    }
    // Prefer the finished release when both it and its snapshot are listed.
    return (
      Number(left.value.endsWith("-SNAPSHOT")) -
      Number(right.value.endsWith("-SNAPSHOT"))
    )
  })
  return parsed[0]?.value ?? null
}
